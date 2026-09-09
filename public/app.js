// Browser side of the R2 upload client.
//
// The file never passes through the page's memory in full: File.slice() returns a
// lazy Blob view, and each slice is handed straight to fetch()/XHR as the request
// body. That is what lets a 65 GB file upload from a tab without exhausting memory.

const LEGACY_PART_CONCURRENCY = 3; // legacy proxied path
const MAX_PART_ATTEMPTS = 3;        // per part, before the file is marked failed
const PRESIGN_BATCH_SIZE = 100;      // presigned URLs fetched at a time
const THEME_KEY = "r2-upload-theme";

// =========================================================================
// DOM references
// =========================================================================

const els = {
  brandKicker: document.getElementById("brand-kicker"),
  bucketNote: document.getElementById("bucket-note"),
  sizeHint: document.getElementById("size-hint"),
  themeSelect: document.getElementById("theme-select"),
  // Browser
  breadcrumb: document.getElementById("breadcrumb"),
  folderGrid: document.getElementById("folder-grid"),
  browserLoading: document.getElementById("browser-loading"),
  browserMore: document.getElementById("browser-more"),
  loadMoreBtn: document.getElementById("load-more-btn"),
  browserSearch: document.getElementById("browser-search"),
  newFolder: document.getElementById("new-folder"),
  newFolderBtn: document.getElementById("new-folder-btn"),
  // Upload
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("file-input"),
  // Queue
  queue: document.getElementById("queue"),
  queueSelectAllWrap: document.getElementById("queue-select-all-wrap"),
  queueSelectAll: document.getElementById("queue-select-all"),
  queueSummary: document.getElementById("queue-summary"),
  uploadBtn: document.getElementById("upload-btn"),
  clearDone: document.getElementById("clear-done"),
  list: document.getElementById("file-list"),
  banner: document.getElementById("banner"),
  // Modal
  modalOverlay: document.getElementById("modal-overlay"),
  modalTitle: document.getElementById("modal-title"),
  modalBody: document.getElementById("modal-body"),
  modalInputWrap: document.getElementById("modal-input-wrap"),
  modalInput: document.getElementById("modal-input"),
  modalCancel: document.getElementById("modal-cancel"),
  modalConfirm: document.getElementById("modal-confirm"),
  modalCheckboxWrap: document.getElementById("modal-checkbox-wrap"),
  modalCheckbox: document.getElementById("modal-checkbox"),
  modalCheckboxLabel: document.getElementById("modal-checkbox-label"),
};

// =========================================================================
// State
// =========================================================================

let config = {
  partSize: 50 * 1024 * 1024,
  singlePutMax: 50 * 1024 * 1024,
  uploadPrefix: "",
  customerName: "",
  bucketLabel: "",
  publicBaseUrl: "",
  email: "",
  presignedUploads: false,
};

// Current browse path (full R2 prefix, e.g. "uploads/sample/")
let currentPrefix = "";
let browseLoading = false;

// Full-fetch browse: all items in the current folder are loaded into memory
// on entry, then rendered in client-side batches for instant paging & search.
const BROWSE_PAGE_SIZE = 300;
let allFolders = []; // { name, prefix }
let allFiles = [];   // { name, key, size }
let displayedCount = 0;

const items = []; // upload records
let pumping = false; // one file at a time

// =========================================================================
// Init
// =========================================================================

init();

async function init() {
  initTheme();
  wireDropzone();
  wireBrowser();
  els.clearDone.addEventListener("click", clearFinished);
  els.uploadBtn.addEventListener("click", startUpload);
  window.addEventListener("beforeunload", warnIfActive);
  window.addEventListener("offline", handleOffline);
  window.addEventListener("online", handleOnline);

  try {
    const res = await fetch("/api/config");
    if (res.status === 403) {
      showBanner("Your session has expired. Reload the page to sign in again.", "error");
      return;
    }
    if (res.ok) {
      config = { ...config, ...(await res.json()) };
      els.sizeHint.textContent =
        `Files over ${formatBytes(config.singlePutMax)} are uploaded in ${formatBytes(config.partSize)} parts.`;
      applyChrome();
    }
  } catch {
    // Non-fatal: defaults are already sane. Real errors surface on upload.
  }

  // Start browsing at the configured prefix root (or bucket root).
  currentPrefix = config.uploadPrefix || "";
  loadFolder(currentPrefix);
}

function applyChrome() {
  const name = (config.customerName || "").trim();
  if (name) {
    els.brandKicker.textContent = name;
    els.brandKicker.hidden = false;
  } else {
    els.brandKicker.textContent = "";
    els.brandKicker.hidden = true;
  }

  const label = (config.bucketLabel || "").trim() || "R2";
  if (config.email) {
    els.bucketNote.textContent = `${label} as ${config.email}`;
  } else {
    els.bucketNote.textContent = label;
  }
}

/** Public URL when PUBLIC_BASE_URL is set; otherwise the full R2 key. */
function objectHref(key) {
  if (!key) return "";
  const base = (config.publicBaseUrl || "").replace(/\/+$/, "");
  if (!base) return key;
  const encoded = key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${base}/${encoded}`;
}

function hasPublicUrl() {
  return Boolean((config.publicBaseUrl || "").trim());
}

// =========================================================================
// Theme
// =========================================================================

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || "system";
  document.documentElement.setAttribute("data-theme", saved);
  els.themeSelect.value = saved;

  els.themeSelect.addEventListener("change", () => {
    const theme = els.themeSelect.value;
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  });
}

// =========================================================================
// Folder browser
// =========================================================================

function wireBrowser() {
  els.loadMoreBtn.addEventListener("click", () => {
    renderBatch(true);
  });
  els.browserSearch.addEventListener("input", applyBrowserFilter);

  els.newFolderBtn.addEventListener("click", createAndEnterFolder);
  els.newFolder.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createAndEnterFolder();
  });

  els.queueSelectAll.addEventListener("change", () => {
    const checked = els.queueSelectAll.checked;
    for (const item of items) {
      if (item.state === "pending") item.selected = checked;
    }
    refreshPendingSelections();
  });
}

function createAndEnterFolder() {
  const raw = els.newFolder.value.trim();
  if (!raw) return;

  // Basic validation: no path traversal, no control chars.
  if (/[\\]/.test(raw) || /\.\./.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) {
    showBanner("Invalid folder name.", "error");
    return;
  }

  // Clean up: strip slashes, spaces.
  const name = raw.replace(/^\/+/, "").replace(/\/+$/, "").trim();
  if (!name) return;

  const newPrefix = `${currentPrefix}${name}/`;
  els.newFolder.value = "";
  navigateTo(newPrefix);
}

function navigateTo(prefix) {
  currentPrefix = prefix;
  loadFolder(prefix);
}

// ---- Full-fetch: load every page of a folder into memory, then render ----

async function loadFolder(prefix) {
  if (browseLoading) return;
  browseLoading = true;

  // Reset in-memory dataset.
  allFolders = [];
  allFiles = [];
  displayedCount = 0;

  els.folderGrid.innerHTML = "";
  els.browserLoading.textContent = "Loading…";
  els.folderGrid.appendChild(els.browserLoading);
  els.browserMore.hidden = true;
  els.browserSearch.value = "";

  renderBreadcrumb(prefix);

  try {
    let cursor = null;
    do {
      const params = new URLSearchParams({ prefix });
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(`/api/browse?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();

      for (const f of data.folders) allFolders.push(f);
      for (const f of data.files) allFiles.push(f);

      const total = allFolders.length + allFiles.length;
      els.browserLoading.textContent = `Loading… ${total.toLocaleString()} items`;

      cursor = data.truncated ? data.cursor : null;
    } while (cursor);

    // All pages fetched — render the first batch.
    els.folderGrid.innerHTML = "";
    renderBatch(false);
  } catch (err) {
    els.folderGrid.innerHTML = "";
    const msg = document.createElement("p");
    msg.className = "browser-empty";
    msg.textContent = "Could not load folder contents. You can still upload files.";
    els.folderGrid.appendChild(msg);
    console.error("Browse error:", err);
  } finally {
    browseLoading = false;
  }
}

// ---- Render a batch of items from the in-memory arrays ----

function renderBatch(append) {
  if (!append) {
    els.folderGrid.innerHTML = "";
    displayedCount = 0;
  }

  const term = els.browserSearch.value.trim().toLowerCase();
  const filteredFolders = term
    ? allFolders.filter((f) => f.name.toLowerCase().includes(term))
    : allFolders;
  const filteredFiles = term
    ? allFiles.filter((f) => f.name.toLowerCase().includes(term))
    : allFiles;
  const totalFiltered = filteredFolders.length + filteredFiles.length;

  // Determine the slice to render this batch.
  const start = displayedCount;
  const end = Math.min(start + BROWSE_PAGE_SIZE, totalFiltered);

  // Combined list: folders first, then files (matching current order).
  const combined = [...filteredFolders, ...filteredFiles];
  const batch = combined.slice(start, end);

  // Add list header on first render (not append).
  if (!append && (filteredFolders.length > 0 || filteredFiles.length > 0)) {
    const header = document.createElement("div");
    header.className = "browse-list-header";
    header.innerHTML = `<span class="blh-icon"></span><span class="blh-name">Name</span><span class="blh-size">Size</span><span class="blh-action"></span>`;
    els.folderGrid.appendChild(header);
  }

  for (const item of batch) {
    if (item.prefix !== undefined) {
      // It's a folder.
      const tile = document.createElement("button");
      tile.className = "folder-tile";
      tile.title = item.name;
      tile.dataset.kind = "folder";
      tile.dataset.name = item.name.toLowerCase();
      tile.innerHTML = `
        <span class="ft-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 2A1.5 1.5 0 000 3.5v9A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5V5a1.5 1.5 0 00-1.5-1.5H7.71L6.85 2.64A1.5 1.5 0 005.71 2H1.5z"/>
        </svg></span>
        <span class="ft-name"></span>
        <span class="ft-meta">-</span>
      `;
      tile.querySelector(".ft-name").textContent = item.name;
      tile.addEventListener("click", () => navigateTo(item.prefix));
      els.folderGrid.appendChild(tile);
    } else {
      // It's a file.
      const entry = document.createElement("div");
      entry.className = "file-entry";
      entry.title = item.name;
      entry.dataset.kind = "file";
      entry.dataset.name = item.name.toLowerCase();

      const copyTitle = hasPublicUrl() ? "Copy source URL" : "Copy key";
      const copySvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
      const checkSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
      entry.innerHTML = `
        <span class="fe-icon"><svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor">
          <path d="M8.5 0H1.5A1.5 1.5 0 000 1.5v13A1.5 1.5 0 001.5 16h11a1.5 1.5 0 001.5-1.5V5.5L8.5 0zM9 1.5L12.5 5H9.5A.5.5 0 019 4.5V1.5zM1.5 15a.5.5 0 01-.5-.5v-13a.5.5 0 01.5-.5H8v4.5A1.5 1.5 0 009.5 6H13v8.5a.5.5 0 01-.5.5h-11z"/>
        </svg></span>
        <span class="fe-name"></span>
        <span class="fe-size"></span>
        <button class="fe-copy" title="${copyTitle}">${copySvg}</button>
      `;
      entry.querySelector(".fe-name").textContent = item.name;
      entry.querySelector(".fe-size").textContent = formatBytes(item.size);
      const copyBtn = entry.querySelector(".fe-copy");
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const value = objectHref(item.key);
        navigator.clipboard.writeText(value).then(() => {
          copyBtn.innerHTML = checkSvg;
          copyBtn.style.color = "var(--success)";
          showBanner(`Copied: ${value}`, "success");
          setTimeout(() => {
            copyBtn.innerHTML = copySvg;
            copyBtn.style.color = "";
          }, 2000);
        });
      });
      els.folderGrid.appendChild(entry);
    }
  }

  displayedCount = end;

  // Empty state.
  if (totalFiltered === 0 && allFolders.length === 0 && allFiles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "browser-empty";
    empty.textContent = "Empty - upload files here or create a subfolder.";
    els.folderGrid.appendChild(empty);
  } else if (totalFiltered === 0 && (allFolders.length > 0 || allFiles.length > 0)) {
    // Search active but no matches.
    const empty = document.createElement("p");
    empty.className = "browser-filter-empty";
    empty.textContent = "No matching folders or files in this folder.";
    els.folderGrid.appendChild(empty);
  }

  // "Load more" button — purely client-side now.
  if (displayedCount < totalFiltered) {
    const remaining = totalFiltered - displayedCount;
    els.loadMoreBtn.textContent = `Showing ${displayedCount} of ${totalFiltered} - load ${Math.min(BROWSE_PAGE_SIZE, remaining)} more`;
    els.browserMore.hidden = false;
  } else {
    els.browserMore.hidden = true;
  }
}

function renderBreadcrumb(prefix) {
  els.breadcrumb.innerHTML = "";

  const confPrefix = config.uploadPrefix || "";

  // Root crumb.
  const rootBtn = document.createElement("button");
  rootBtn.className = "crumb";
  rootBtn.textContent = confPrefix ? `/ ${confPrefix.replace(/\/$/, "")}` : "/ (root)";
  rootBtn.dataset.prefix = confPrefix;
  if (prefix !== confPrefix) {
    rootBtn.addEventListener("click", () => navigateTo(confPrefix));
  }
  els.breadcrumb.appendChild(rootBtn);

  // Remaining segments.
  const relative = prefix.startsWith(confPrefix) ? prefix.slice(confPrefix.length) : prefix;
  if (!relative) return;

  const segments = relative.replace(/\/$/, "").split("/").filter(Boolean);
  let accumulated = confPrefix;

  for (let i = 0; i < segments.length; i++) {
    accumulated += segments[i] + "/";

    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "/";
    els.breadcrumb.appendChild(sep);

    const btn = document.createElement("button");
    btn.className = "crumb";
    btn.textContent = segments[i];
    btn.dataset.prefix = accumulated;

    if (i < segments.length - 1) {
      const target = accumulated;
      btn.addEventListener("click", () => navigateTo(target));
    }
    els.breadcrumb.appendChild(btn);
  }
}

// =========================================================================
// Dropzone / file input
// =========================================================================

function wireDropzone() {
  const dz = els.dropzone;
  dz.addEventListener("click", () => els.fileInput.click());
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.fileInput.click();
    }
  });

  els.fileInput.addEventListener("change", () => {
    addFiles(els.fileInput.files);
    els.fileInput.value = "";
  });

  for (const type of ["dragenter", "dragover"]) {
    dz.addEventListener(type, (e) => {
      e.preventDefault();
      dz.classList.add("over");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    dz.addEventListener(type, (e) => {
      e.preventDefault();
      dz.classList.remove("over");
    });
  }
  dz.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
}

function addFiles(fileList) {
  for (const file of fileList) {
    // Build key from current browser path (NOT hardcoded "uploads/").
    // The server's resolveKey will apply UPLOAD_PREFIX if configured.
    const relativePath = currentPrefix.startsWith(config.uploadPrefix || "")
      ? currentPrefix.slice((config.uploadPrefix || "").length)
      : currentPrefix;
    const key = `${relativePath}${file.name}`;

    const item = {
      id: `u${items.length}-${Date.now()}`,
      file,
      key,
      overwrite: false,
      selected: false,
      state: "pending", // NOT "queued" — waits for explicit Upload click
      loaded: 0,
      uploadId: null,
      controllers: new Set(),
      cancelled: false,
      paused: false,
      pauseReason: null,       // "user" | "network" | null
      _pausePromise: null,
      _pauseResolve: null,
      _clearPresignCache: null,
      startedAt: 0,
      pausedAt: 0,             // timestamp when paused (for ETA adjustment)
      pausedDuration: 0,       // total ms spent paused
      finalKey: null,
      message: "",
      conflict: null,
      storedAfterCancel: false,
      row: null,
    };
    items.push(item);
    renderRow(item);
  }

  updateQueueVisibility();
}

// =========================================================================
// Submit-gated upload
// =========================================================================

function startUpload() {
  const pendingItems = items.filter((item) => item.state === "pending");
  if (pendingItems.length === 0) {
    showBanner("Add files before uploading.", "error");
    return;
  }

  const selectedPending = pendingItems.filter((item) => item.selected === true);
  if (selectedPending.length === 0) {
    showBanner("Select at least one file to upload.", "error");
    return;
  }

  let started = 0;
  for (const item of items) {
    if (item.state === "pending" && item.selected) {
      item.state = "queued";
      update(item);
      started++;
    }
  }
  if (started > 0) {
    updateQueueVisibility();
    pump();
  }
}

// =========================================================================
// Queue pump
// =========================================================================

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = items.find((i) => i.state === "queued");
      if (!next) break;
      await runUpload(next);
    }
  } finally {
    pumping = false;
    updateQueueVisibility();
    // Refresh browser to show newly uploaded files.
    loadFolder(currentPrefix);
  }
}

async function runUpload(item) {
  item.state = "uploading";
  item.loaded = 0;
  item.cancelled = false;
  item.paused = false;
  item.pauseReason = null;
  item.pausedDuration = 0;
  item.storedAfterCancel = false;
  item.startedAt = Date.now();
  update(item);

  try {
    if (item.file.size <= config.singlePutMax) {
      await (config.presignedUploads ? uploadSinglePresigned(item) : uploadSingle(item));
    } else {
      await (config.presignedUploads ? uploadMultipartPresigned(item) : uploadMultipart(item));
    }
    if (item.cancelled) {
      await resolveCancelOutcome(item);
      return;
    }
    item.state = "done";
    item.loaded = item.file.size;
    update(item);
  } catch (err) {
    if (item.cancelled) {
      await resolveCancelOutcome(item);
      return;
    }
    item.state = err.conflict ? "conflict" : "error";
    item.message = err.message;
    item.conflict = err.conflict || null;
    update(item);
  } finally {
    item.controllers.clear();
  }
}

/**
 * After an in-flight cancel, one HEAD tells whether the object actually landed.
 * Queued/never-started cancels skip this (no network yet).
 */
async function resolveCancelOutcome(item) {
  // Already handled by immediate cancel in cancel().
  if (item.state === "cancelled") return;
  const key = item.finalKey || item.key;
  item.state = "cancelled";

  if (!key) {
    item.message = "Cancelled";
    update(item);
    return;
  }

  try {
    const params = new URLSearchParams({ key });
    const res = await fetch(`/api/head?${params}`);
    if (res.ok) {
      const data = await res.json();
      if (data.exists) {
        item.finalKey = data.key || key;
        item.storedAfterCancel = true;
        item.message = `Cancelled - object is stored at ${objectHref(item.finalKey)}`;
        update(item);
        return;
      }
    }
  } catch {
    // Fall through to "nothing stored" if HEAD fails.
  }

  item.storedAfterCancel = false;
  item.message = "Cancelled - nothing stored.";
  update(item);
}

// =========================================================================
// Single-shot upload (XHR for upload progress)
// =========================================================================

async function uploadSingle(item) {
  const params = new URLSearchParams({ key: item.key });
  if (item.overwrite) params.set("overwrite", "true");

  const headers = {};
  if (item.file.type) headers["Content-Type"] = item.file.type;

  const data = await xhrPut(`/api/upload/single?${params}`, item.file, item, headers);

  item.finalKey = data.key;
  item.loaded = item.file.size;
}

/**
 * PUT with upload progress. Controllers hold AbortController-like objects;
 * XHR itself exposes .abort(), so it can live in the same Set.
 */
function xhrPut(url, body, item, headers = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.controllers.add(xhr);

    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) {
      if (value) xhr.setRequestHeader(name, value);
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      item.loaded = event.loaded;
      update(item);
    };

    xhr.onload = () => {
      item.controllers.delete(xhr);
      const raw = xhr.responseText || "";
      let parsed = {};
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        parsed = {};
      }

      const fakeRes = {
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        statusText: xhr.statusText,
        json: async () => parsed,
      };

      parseResponse(fakeRes, parsed)
        .then(resolve)
        .catch(reject);
    };

    xhr.onerror = () => {
      item.controllers.delete(xhr);
      reject(new Error("Network error during upload"));
    };

    xhr.onabort = () => {
      item.controllers.delete(xhr);
      const err = new Error("Cancelled");
      reject(err);
    };

    xhr.send(body);
  });
}

// =========================================================================
// Presigned single upload — browser PUTs directly to R2
// =========================================================================

async function uploadSinglePresigned(item) {
  // Step 1: Get presigned URL from Worker (no file body sent here).
  const presign = await parseResponse(
    await fetch("/api/upload/presign-single", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: item.key,
        size: item.file.size,
        contentType: item.file.type || undefined,
        overwrite: item.overwrite,
      }),
    }),
  );

  item.finalKey = presign.key;

  // Step 2: PUT directly to R2 via presigned URL.
  const headers = presign.requiredHeaders || {};
  await xhrPut(presign.presignedUrl, item.file, item, headers);
  item.loaded = item.file.size;
}

// =========================================================================
// Presigned multipart upload — parts go directly to R2
// =========================================================================

async function uploadMultipartPresigned(item) {
  // Step 1: Create multipart upload (still via Worker → R2 binding).
  const created = await parseResponse(
    await fetch("/api/upload/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: item.key,
        size: item.file.size,
        contentType: item.file.type || undefined,
        overwrite: item.overwrite,
      }),
    }),
  );

  item.uploadId = created.uploadId;
  item.finalKey = created.key;
  const partSize = created.partSize;
  const partCount = created.partCount;
  const concurrency = computeConcurrency(partSize);

  const parts = new Array(partCount);
  const partProgress = new Array(partCount).fill(0);
  let nextPart = 0;

  // Presigned URL cache — fetched in batches as workers need them.
  const presignedUrls = {};
  // One shared promise per batch so all workers wait on the same fetch.
  const batchPromises = {};

  // Expose cache clearing so resumeItem can invalidate expired URLs.
  item._clearPresignCache = () => {
    for (const key of Object.keys(presignedUrls)) delete presignedUrls[key];
    for (const key of Object.keys(batchPromises)) delete batchPromises[key];
  };

  async function fetchPresignedBatch(batchStart) {
    const needed = [];
    for (let i = batchStart; i < batchStart + PRESIGN_BATCH_SIZE && i < partCount; i++) {
      if (!presignedUrls[i + 1]) needed.push(i + 1);
    }
    if (needed.length === 0) return;

    const res = await parseResponse(
      await fetch("/api/upload/presign-parts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: item.finalKey,
          uploadId: item.uploadId,
          parts: needed,
        }),
      }),
    );
    Object.assign(presignedUrls, res.urls);
  }

  function ensurePresignedUrls(index) {
    const batchStart = Math.floor(index / PRESIGN_BATCH_SIZE) * PRESIGN_BATCH_SIZE;
    if (!batchPromises[batchStart]) {
      batchPromises[batchStart] = fetchPresignedBatch(batchStart);
    }
    return batchPromises[batchStart];
  }

  const worker = async () => {
    for (;;) {
      if (item.cancelled) return;
      // Block here while paused — workers that finish their current part
      // wait until resumed. In-flight XHRs complete (don't waste bytes).
      while (item.paused) {
        await item._pausePromise;
        if (item.cancelled) return;
      }
      const index = nextPart++;
      if (index >= partCount) return;

      // Wait for this batch's presigned URLs — all workers in the same
      // batch share one fetch promise, so the request happens only once.
      await ensurePresignedUrls(index);

      const partNumber = index + 1;
      const presignedUrl = presignedUrls[partNumber];
      if (!presignedUrl) {
        throw new Error(`No presigned URL for part ${partNumber}`);
      }

      const start = index * partSize;
      const blob = item.file.slice(start, Math.min(start + partSize, item.file.size));

      parts[index] = await uploadPartPresigned(
        item, partNumber, blob, presignedUrl,
        (loaded) => {
          partProgress[index] = loaded;
          item.loaded = partProgress.reduce((a, b) => a + b, 0);
          update(item);
        },
      );

      // Mark part as fully done in progress.
      partProgress[index] = blob.size;
      item.loaded = partProgress.reduce((a, b) => a + b, 0);
      update(item);
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, partCount) }, worker),
    );
    if (item.cancelled) throw new Error("Cancelled");

    // Step 3: Complete (still via Worker → R2 binding).
    const data = await parseResponse(
      await fetch("/api/upload/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: item.finalKey,
          uploadId: item.uploadId,
          parts: parts.filter(Boolean),
        }),
      }),
    );
    item.finalKey = data.key;
    item.uploadId = null;
  } catch (err) {
    await abortUpload(item);
    throw err;
  }
}

async function uploadPartPresigned(item, partNumber, blob, presignedUrl, onProgress) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt++) {
    if (item.cancelled) throw new Error("Cancelled");

    try {
      const xhr = await xhrPutRaw(presignedUrl, blob, item, onProgress);
      const etag = xhr.getResponseHeader("ETag");
      return { partNumber, etag };
    } catch (err) {
      lastErr = err;
      if (item.cancelled) throw err;
      // If offline, wait for connectivity instead of burning retry attempts.
      if (!navigator.onLine) {
        await new Promise((resolve) =>
          window.addEventListener("online", resolve, { once: true }),
        );
        attempt--; // don't count this as an attempt
        continue;
      }
      if (attempt < MAX_PART_ATTEMPTS) {
        await sleep(2 ** attempt * 500);
      }
    }
  }
  throw new Error(
    `Part ${partNumber} failed after ${MAX_PART_ATTEMPTS} attempts: ${lastErr?.message || "unknown error"}`,
  );
}

/**
 * PUT with progress — returns the raw XHR so the caller can read response headers
 * (e.g. ETag from R2). Unlike xhrPut(), does not parse the response as JSON.
 */
function xhrPutRaw(url, body, item, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.controllers.add(xhr);

    xhr.open("PUT", url);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded);
      }
    };

    xhr.onload = () => {
      item.controllers.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr);
      } else {
        reject(new Error(`Part upload failed: HTTP ${xhr.status}`));
      }
    };

    xhr.onerror = () => {
      item.controllers.delete(xhr);
      reject(new Error("Network error during upload"));
    };

    xhr.onabort = () => {
      item.controllers.delete(xhr);
      reject(new Error("Cancelled"));
    };

    xhr.send(body);
  });
}

/** Scale concurrency inversely with part size — large parts saturate bandwidth. */
function computeConcurrency(partSize) {
  const MB = 1024 * 1024;
  if (partSize <= 50 * MB) return 12;
  if (partSize <= 300 * MB) return 10;
  if (partSize <= 512 * MB) return 8;
  if (partSize <= 1024 * MB) return 6;
  return 4;
}

// =========================================================================
// Multipart upload (legacy proxied path)
// =========================================================================

async function uploadMultipart(item) {
  const created = await parseResponse(
    await fetch("/api/upload/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: item.key,
        size: item.file.size,
        contentType: item.file.type || undefined,
        overwrite: item.overwrite,
      }),
    }),
  );

  item.uploadId = created.uploadId;
  item.finalKey = created.key;
  const partSize = created.partSize;
  const partCount = created.partCount;

  const parts = new Array(partCount);
  const progress = new Array(partCount).fill(0);
  let nextPart = 0;

  const worker = async () => {
    for (;;) {
      if (item.cancelled) return;
      while (item.paused) {
        await item._pausePromise;
        if (item.cancelled) return;
      }
      const index = nextPart++;
      if (index >= partCount) return;

      const partNumber = index + 1;
      const start = index * partSize;
      const blob = item.file.slice(start, Math.min(start + partSize, item.file.size));

      parts[index] = await uploadPart(item, partNumber, blob, () => {
        progress[index] = blob.size;
        item.loaded = progress.reduce((a, b) => a + b, 0);
        update(item);
      });
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(LEGACY_PART_CONCURRENCY, partCount) }, worker),
    );
    if (item.cancelled) throw new Error("Cancelled");

    const data = await parseResponse(
      await fetch("/api/upload/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: item.finalKey,
          uploadId: item.uploadId,
          parts: parts.filter(Boolean),
        }),
      }),
    );
    item.finalKey = data.key;
    item.uploadId = null;
  } catch (err) {
    await abortUpload(item);
    throw err;
  }
}

async function uploadPart(item, partNumber, blob, onDone) {
  const params = new URLSearchParams({
    key: item.finalKey,
    uploadId: item.uploadId,
    partNumber: String(partNumber),
  });

  let lastErr;
  for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt++) {
    if (item.cancelled) throw new Error("Cancelled");

    const controller = new AbortController();
    item.controllers.add(controller);
    try {
      const res = await fetch(`/api/upload/part?${params}`, {
        method: "PUT",
        body: blob,
        signal: controller.signal,
      });
      const part = await parseResponse(res);
      onDone();
      return { partNumber: part.partNumber, etag: part.etag };
    } catch (err) {
      lastErr = err;
      if (item.cancelled || err.fatal) throw err;
      if (attempt < MAX_PART_ATTEMPTS) {
        await sleep(2 ** attempt * 500);
      }
    } finally {
      item.controllers.delete(controller);
    }
  }
  throw new Error(
    `Part ${partNumber} failed after ${MAX_PART_ATTEMPTS} attempts: ${lastErr?.message || "unknown error"}`,
  );
}

async function abortUpload(item) {
  if (!item.uploadId) return;
  try {
    await fetch("/api/upload/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: item.finalKey, uploadId: item.uploadId }),
    });
  } catch {
    // Best effort; R2 reaps incomplete uploads after 7 days regardless.
  }
  item.uploadId = null;
}

// =========================================================================
// Response parsing
// =========================================================================

async function parseResponse(res, preParsed) {
  if (res.ok) {
    if (res.status === 204) return {};
    try {
      return preParsed !== undefined ? preParsed : await res.json();
    } catch {
      return {};
    }
  }

  let body = preParsed;
  if (body === undefined) {
    body = {};
    try {
      body = await res.json();
    } catch {
      // Non-JSON error.
    }
  }

  if (res.status === 403 || res.status === 401) {
    const err = new Error("Your session has expired - reload the page to sign in again.");
    err.fatal = true;
    showBanner(err.message, "error");
    throw err;
  }

  if (res.status === 409) {
    const existing = body.existing;
    const detail = existing
      ? ` (existing: ${formatBytes(existing.size)}${existing.uploaded ? `, uploaded ${new Date(existing.uploaded).toLocaleString()}` : ""})`
      : "";
    const err = new Error(`An object already exists at that key${detail}`);
    err.fatal = true;
    err.conflict = {
      key: body.key,
      size: existing?.size,
      uploaded: existing?.uploaded ?? null,
      uploadedBy: existing?.uploadedBy ?? null,
    };
    throw err;
  }

  const err = new Error(body.error || `Upload failed (HTTP ${res.status})`);
  if (res.status === 400) err.fatal = true;
  throw err;
}

// =========================================================================
// Rendering
// =========================================================================

function renderRow(item) {
  const li = document.createElement("li");
  li.className = "row";
  li.innerHTML = `
    <div class="row-main">
      <label class="row-select" hidden>
        <input type="checkbox" class="row-checkbox" />
        <span class="sr-only">Select file</span>
      </label>
      <span class="row-select-spacer" hidden></span>
      <div class="row-body">
        <div class="row-top">
          <span class="name"></span>
          <span class="size"></span>
        </div>
        <div class="bar"><i></i></div>
        <div class="row-bot">
          <span class="state"></span>
          <span class="actions"></span>
        </div>
        <p class="key" hidden></p>
      </div>
    </div>
  `;
  li.querySelector(".name").textContent = item.file.name;
  li.querySelector(".size").textContent = formatBytes(item.file.size);
  li.querySelector(".row-checkbox").addEventListener("change", (e) => {
    item.selected = e.target.checked;
    refreshPendingSelections();
  });
  els.list.appendChild(li);
  item.row = li;
  update(item);
}

function update(item) {
  const li = item.row;
  if (!li) return;

  const pct = item.file.size
    ? Math.min(100, Math.round((item.loaded / item.file.size) * 100))
    : 0;
  li.querySelector(".bar > i").style.width = `${item.state === "done" ? 100 : pct}%`;
  li.className = `row ${item.state}${item.paused ? " paused" : ""}`;

  const state = li.querySelector(".state");
  switch (item.state) {
    case "pending":
      state.textContent = "Ready to upload";
      break;
    case "queued":
      state.textContent = "Queued";
      break;
    case "uploading": {
      if (item.paused) {
        state.textContent =
          `Paused · ${formatBytes(item.loaded)} of ${formatBytes(item.file.size)}`;
        break;
      }
      const elapsed = (Date.now() - item.startedAt - item.pausedDuration) / 1000;
      const rate = elapsed > 0.5 ? item.loaded / elapsed : 0;
      const remaining = item.file.size - item.loaded;
      const eta = rate > 0 ? remaining / rate : 0;
      state.textContent =
        `${pct}% · ${formatBytes(item.loaded)} of ${formatBytes(item.file.size)}` +
        (rate ? ` · ${formatBytes(rate)}/s` : "") +
        (eta > 1 ? ` · ${formatEta(eta)} remaining` : "");
      break;
    }
    case "done":
      state.textContent = "Uploaded";
      break;
    case "cancelled":
      state.textContent = item.message || "Cancelled";
      break;
    case "conflict":
    case "error":
      state.textContent = item.message || "Failed";
      break;
  }

  const keyEl = li.querySelector(".key");
  const showHref =
    (item.state === "done" && item.finalKey) ||
    (item.state === "cancelled" && item.storedAfterCancel && item.finalKey) ||
    (item.state === "pending" && item.key);

  if (showHref) {
    keyEl.hidden = false;
    if (item.state === "pending") {
      keyEl.textContent = `→ ${item.key}`;
    } else {
      keyEl.textContent = objectHref(item.finalKey);
    }
  } else {
    keyEl.hidden = true;
  }

  // Only re-render action buttons when state actually changes — avoids
  // DOM thrashing on every progress tick that causes hover-to-click bugs.
  const actionsHost = li.querySelector(".actions");
  const stateKey = `${item.state}:${item.paused}:${item.pauseReason}`;
  if (actionsHost._renderedForState !== stateKey) {
    renderActions(item, actionsHost);
    actionsHost._renderedForState = stateKey;
  }
  renderSelection(item, li);
  updateQueueVisibility();
}

function renderSelection(item, li) {
  const selectWrap = li.querySelector(".row-select");
  const spacer = li.querySelector(".row-select-spacer");
  const checkbox = li.querySelector(".row-checkbox");
  const isPending = item.state === "pending";

  selectWrap.style.display = isPending ? "inline-flex" : "none";
  spacer.style.display = isPending ? "none" : "block";
  checkbox.disabled = !isPending;

  if (isPending) {
    checkbox.checked = item.selected === true;
  } else {
    checkbox.checked = false;
  }
}

function renderActions(item, host) {
  host.textContent = "";

  const add = (label, onClick, className) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn btn-sm${className ? " " + className : ""}`;
    b.textContent = label;
    b.addEventListener("click", onClick);
    host.appendChild(b);
  };

  if (item.state === "pending") {
    add("Remove", () => removeItem(item), "btn-danger");
  }

  if (item.state === "uploading" || item.state === "queued") {
    // Pause only for multipart uploads (large files) that are actively uploading.
    if (item.state === "uploading" && !item.paused && item.file.size > config.singlePutMax) {
      add("Pause", () => pauseItem(item));
    }
    if (item.paused && item.pauseReason === "user") {
      add("Resume", () => resumeItem(item));
    }
    if (item.paused && item.pauseReason === "network") {
      const span = document.createElement("span");
      span.className = "network-wait-label";
      span.textContent = "Waiting for network…";
      host.appendChild(span);
    }
    add("Cancel", () => cancel(item));
  }

  if (item.state === "error") {
    add("Retry", () => retry(item));
  }

  if (item.state === "conflict") {
    add("Rename", () => rename(item));
    add("Overwrite", () => confirmOverwrite(item));
  }

  const copyKey =
    (item.state === "done" && item.finalKey) ||
    (item.state === "cancelled" && item.storedAfterCancel && item.finalKey);
  if (copyKey) {
    const value = objectHref(item.finalKey);
    const label = hasPublicUrl() ? "Copy URL" : "Copy key";
    add(label, async () => {
      try {
        await navigator.clipboard.writeText(value);
        showBanner(`Copied ${value}`, "success");
      } catch {
        showBanner("Could not copy to clipboard.", "error");
      }
    });
  }
}

// =========================================================================
// Custom modal (replaces native confirm / prompt)
// =========================================================================

/**
 * Show a modal dialog. Returns a Promise that resolves with:
 *   - null when cancelled,
 *   - When no checkbox: the input value (string) or true (confirm-only),
 *   - When checkbox present: { value: string|true, checked: boolean }.
 */
function showModal({ title, body = "", inputValue, inputHidden = true, confirmLabel = "Confirm", danger = false, checkboxLabel }) {
  return new Promise((resolve) => {
    const modal = els.modalOverlay.querySelector(".modal");
    const hasCheckbox = Boolean(checkboxLabel);
    els.modalTitle.textContent = title;
    els.modalBody.textContent = body;
    els.modalInputWrap.hidden = inputHidden;
    if (!inputHidden) {
      els.modalInput.value = inputValue ?? "";
    }
    els.modalCheckboxWrap.hidden = !hasCheckbox;
    if (hasCheckbox) {
      els.modalCheckboxLabel.textContent = checkboxLabel;
      els.modalCheckbox.checked = true;
    }
    els.modalConfirm.textContent = confirmLabel;
    modal.classList.toggle("modal-danger", danger);
    els.modalOverlay.hidden = false;

    // Focus the input or the confirm button.
    if (!inputHidden) {
      els.modalInput.focus();
      els.modalInput.select();
    } else {
      els.modalConfirm.focus();
    }

    function teardown() {
      els.modalOverlay.hidden = true;
      els.modalConfirm.removeEventListener("click", onConfirm);
      els.modalCancel.removeEventListener("click", onCancel);
      els.modalOverlay.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
    }

    function result() {
      const value = inputHidden ? true : els.modalInput.value;
      return hasCheckbox ? { value, checked: els.modalCheckbox.checked } : value;
    }

    function onConfirm() {
      teardown();
      resolve(result());
    }

    function onCancel() {
      teardown();
      resolve(null);
    }

    function onBackdrop(e) {
      if (e.target === els.modalOverlay) onCancel();
    }

    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); onConfirm(); }
    }

    els.modalConfirm.addEventListener("click", onConfirm);
    els.modalCancel.addEventListener("click", onCancel);
    els.modalOverlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

async function confirmOverwrite(item) {
  const key = item.conflict?.key || item.key;
  const size = item.conflict?.size;
  const uploaded = item.conflict?.uploaded;
  const uploadedBy = item.conflict?.uploadedBy;
  const details = [];
  if (Number.isFinite(size)) details.push(`Existing size: ${formatBytes(size)}`);
  if (uploaded) details.push(`Uploaded: ${new Date(uploaded).toLocaleString()}`);
  if (uploadedBy) details.push(`Uploaded by: ${uploadedBy}`);
  details.push("This cannot be undone from this tool.");

  const result = await showModal({
    title: "Overwrite existing file?",
    body: `"${key}"\n${details.join("\n")}`,
    inputHidden: true,
    confirmLabel: "Overwrite",
    danger: true,
  });
  if (!result) return;

  item.overwrite = true;
  retry(item);
}

function updateQueueVisibility() {
  const hasItems = items.length > 0;
  els.queue.hidden = !hasItems;

  const pendingItems = items.filter((i) => i.state === "pending");
  const pendingCount = pendingItems.length;
  const pendingSize = pendingItems.reduce((sum, i) => sum + i.file.size, 0);
  const selectedPending = pendingItems.filter((i) => i.selected === true);
  const selectedPendingCount = selectedPending.length;
  const selectedPendingSize = selectedPending.reduce(
    (sum, i) => sum + i.file.size,
    0,
  );
  const activeCount = items.filter(
    (i) => i.state === "queued" || i.state === "uploading",
  ).length;
  const doneCount = items.filter((i) => i.state === "done").length;

  els.uploadBtn.hidden = false;
  els.uploadBtn.disabled = false;

  els.queueSelectAllWrap.hidden = pendingCount === 0;
  if (pendingCount > 0) {
    els.queueSelectAll.checked = selectedPendingCount === pendingCount;
    els.queueSelectAll.indeterminate =
      selectedPendingCount > 0 && selectedPendingCount < pendingCount;
  } else {
    els.queueSelectAll.checked = false;
    els.queueSelectAll.indeterminate = false;
  }

  // Build summary — destination is per-row; summary only counts selection.
  const parts = [];
  if (pendingCount > 0) {
    parts.push(
      `${selectedPendingCount} of ${pendingCount} selected (${formatBytes(selectedPendingSize)} of ${formatBytes(pendingSize)})`,
    );
  }
  if (activeCount > 0) parts.push(`${activeCount} uploading`);
  if (doneCount > 0) parts.push(`${doneCount} done`);
  els.queueSummary.textContent = parts.join(" · ");
}

function refreshPendingSelections() {
  for (const item of items) {
    if (item.row) renderSelection(item, item.row);
  }
  updateQueueVisibility();
}

// =========================================================================
// Item actions
// =========================================================================

function removeItem(item) {
  const idx = items.indexOf(item);
  if (idx !== -1) {
    items.splice(idx, 1);
    item.row?.remove();
    updateQueueVisibility();
  }
}

async function cancel(item) {
  // Confirmation modal for in-flight uploads.
  if (item.state === "uploading") {
    const confirmed = await showModal({
      title: "Cancel upload?",
      body: `${formatBytes(item.loaded)} of ${formatBytes(item.file.size)} uploaded so far. This cannot be undone.`,
      confirmLabel: "Cancel upload",
      danger: true,
    });
    if (!confirmed) return;
    // Upload may have completed while the modal was open.
    if (item.state === "done") return;
  }

  // Unpause first so workers can exit cleanly.
  if (item.paused && item._pauseResolve) {
    item.paused = false;
    item._pauseResolve();
  }

  item.cancelled = true;
  for (const c of item.controllers) c.abort();

  // Immediate state transition for ALL states (including in-flight).
  item.state = "cancelled";
  item.message = "Cancelled";
  update(item);

  // Fire-and-forget multipart cleanup.
  abortUpload(item);
}

function pauseItem(item, reason = "user") {
  if (item.state !== "uploading" || item.paused) return;
  item.paused = true;
  item.pauseReason = reason;
  item.pausedAt = Date.now();
  item._pausePromise = new Promise((resolve) => {
    item._pauseResolve = resolve;
  });
  update(item);
}

function resumeItem(item) {
  if (!item.paused) return;
  // Track time spent paused so ETA calculation stays accurate.
  if (item.pausedAt) {
    item.pausedDuration += Date.now() - item.pausedAt;
    item.pausedAt = 0;
  }
  item.paused = false;
  item.pauseReason = null;
  // Clear cached presigned URLs — they may have expired during pause.
  if (item._clearPresignCache) item._clearPresignCache();
  if (item._pauseResolve) {
    item._pauseResolve();
    item._pauseResolve = null;
    item._pausePromise = null;
  }
  update(item);
}

function retry(item) {
  item.state = "queued";
  item.message = "";
  item.conflict = null;
  item.loaded = 0;
  item.storedAfterCancel = false;
  update(item);
  pump();
}

async function rename(item) {
  // Show only the filename for editing; preserve the folder prefix.
  const lastSlash = item.key.lastIndexOf("/");
  const currentName = lastSlash >= 0 ? item.key.slice(lastSlash + 1) : item.key;
  const prefix = lastSlash >= 0 ? item.key.slice(0, lastSlash + 1) : "";

  const result = await showModal({
    title: "Rename file",
    body: prefix ? `In folder: ${prefix}` : "",
    inputValue: currentName,
    inputHidden: false,
    confirmLabel: "Rename",
    checkboxLabel: "Upload immediately after rename",
  });
  if (!result || !result.value.trim()) return;

  item.key = prefix + result.value.trim();
  item.overwrite = false;

  if (result.checked) {
    retry(item);
  } else {
    // Return to pending — user must select and click Upload.
    item.state = "pending";
    item.message = "";
    item.conflict = null;
    item.selected = true;
    update(item);
    updateQueueVisibility();
  }
}

function clearFinished() {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (["done", "cancelled", "error", "conflict"].includes(it.state)) {
      it.row?.remove();
      items.splice(i, 1);
    }
  }
  updateQueueVisibility();
}

function applyBrowserFilter() {
  // Re-render the grid from the full in-memory dataset, filtered by the
  // current search term. This makes search exhaustive across all items.
  renderBatch(false);
}

// =========================================================================
// Misc
// =========================================================================

function warnIfActive(event) {
  const active = items.some(
    (i) => i.state === "uploading" || i.state === "queued",
  );
  if (active) {
    event.preventDefault();
    event.returnValue = "";
  }
}

function handleOffline() {
  let paused = 0;
  for (const item of items) {
    if (item.state === "uploading" && !item.paused) {
      pauseItem(item, "network");
      paused++;
    }
  }
  if (paused > 0) {
    showBanner(
      "Network lost — uploads paused. Will resume when connection is restored.",
      "error",
      { persistent: true },
    );
  }
}

function handleOnline() {
  let resumed = 0;
  for (const item of items) {
    if (item.paused && item.pauseReason === "network") {
      resumeItem(item);
      resumed++;
    }
  }
  if (resumed > 0) {
    showBanner("Network restored — resuming uploads.", "success");
  }
}

let bannerTimer;
function showBanner(message, variant = "", opts = {}) {
  els.banner.textContent = message;
  els.banner.className = variant === "error" ? "banner error"
    : variant === "success" ? "banner success"
    : "banner";
  els.banner.classList.remove("is-hiding");
  els.banner.hidden = false;
  clearTimeout(bannerTimer);
  if (!opts.persistent) {
    bannerTimer = setTimeout(() => {
      els.banner.classList.add("is-hiding");
      setTimeout(() => {
        els.banner.hidden = true;
        els.banner.classList.remove("is-hiding");
      }, 300);
    }, 5000);
  }
}

function formatEta(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
