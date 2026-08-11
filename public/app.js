// Browser side of the R2 upload client.
//
// The file never passes through the page's memory in full: File.slice() returns a
// lazy Blob view, and each slice is handed straight to fetch() as the request body.
// That is what lets a 65 GB file upload from a tab without exhausting memory.

const PART_CONCURRENCY = 3; // parts in flight within one file
const MAX_PART_ATTEMPTS = 3; // per part, before the file is marked failed
const THEME_KEY = "r2-upload-theme";

// =========================================================================
// DOM references
// =========================================================================

const els = {
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
};

// =========================================================================
// State
// =========================================================================

let config = {
  partSize: 50 * 1024 * 1024,
  singlePutMax: 50 * 1024 * 1024,
  uploadPrefix: "",
};

// Current browse path (full R2 prefix, e.g. "uploads/sample/")
let currentPrefix = "";
let browseLoading = false;

// Full-fetch browse: all items in the current folder are loaded into memory
// on entry, then rendered in client-side batches for instant paging & search.
const BROWSE_PAGE_SIZE = 3;
let allFolders = []; // { name, prefix }
let allFiles = [];   // { name, size }
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

  try {
    const res = await fetch("/api/config");
    if (res.status === 403) {
      showBanner("Your session has expired. Reload the page to sign in again.", true);
      return;
    }
    if (res.ok) {
      config = await res.json();
      els.sizeHint.textContent =
        `Files over ${formatBytes(config.singlePutMax)} are uploaded in ${formatBytes(config.partSize)} parts.`;
      if (config.email) {
        els.bucketNote.textContent = `R2 as ${config.email}`;
      }
    }
  } catch {
    // Non-fatal: defaults are already sane. Real errors surface on upload.
  }

  // Start browsing at the configured prefix root (or bucket root).
  currentPrefix = config.uploadPrefix || "";
  loadFolder(currentPrefix);
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
    showBanner("Invalid folder name.", true);
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

  for (const item of batch) {
    if (item.prefix !== undefined) {
      // It's a folder.
      const tile = document.createElement("button");
      tile.className = "folder-tile";
      tile.title = item.name;
      tile.dataset.kind = "folder";
      tile.dataset.name = item.name.toLowerCase();
      tile.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 2A1.5 1.5 0 000 3.5v9A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5V5a1.5 1.5 0 00-1.5-1.5H7.71L6.85 2.64A1.5 1.5 0 005.71 2H1.5z"/>
        </svg>
        <span></span>
      `;
      tile.querySelector("span").textContent = item.name;
      tile.addEventListener("click", () => navigateTo(item.prefix));
      els.folderGrid.appendChild(tile);
    } else {
      // It's a file.
      const entry = document.createElement("div");
      entry.className = "file-entry";
      entry.title = item.name;
      entry.dataset.kind = "file";
      entry.dataset.name = item.name.toLowerCase();
      entry.innerHTML = `<span class="fe-name"></span><span class="fe-size"></span>`;
      entry.querySelector(".fe-name").textContent = item.name;
      entry.querySelector(".fe-size").textContent = formatBytes(item.size);
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
    els.loadMoreBtn.textContent = `Showing ${displayedCount} of ${totalFiltered} — load ${Math.min(BROWSE_PAGE_SIZE, remaining)} more`;
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
      startedAt: 0,
      finalKey: null,
      message: "",
      conflict: null,
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
    showBanner("Add files before uploading.", true);
    return;
  }

  const selectedPending = pendingItems.filter((item) => item.selected === true);
  if (selectedPending.length === 0) {
    showBanner("Select at least one file to upload.", true);
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
  item.startedAt = Date.now();
  update(item);

  try {
    if (item.file.size <= config.singlePutMax) {
      await uploadSingle(item);
    } else {
      await uploadMultipart(item);
    }
    if (item.cancelled) return;
    item.state = "done";
    item.loaded = item.file.size;
    update(item);
  } catch (err) {
    if (item.cancelled) {
      item.state = "cancelled";
      item.message = "Cancelled";
      update(item);
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

// =========================================================================
// Single-shot upload
// =========================================================================

async function uploadSingle(item) {
  const params = new URLSearchParams({ key: item.key });
  if (item.overwrite) params.set("overwrite", "true");

  const controller = new AbortController();
  item.controllers.add(controller);

  const res = await fetch(`/api/upload/single?${params}`, {
    method: "PUT",
    body: item.file,
    headers: item.file.type ? { "Content-Type": item.file.type } : undefined,
    signal: controller.signal,
  });

  const data = await parseResponse(res);
  item.finalKey = data.key;
  item.loaded = item.file.size;
}

// =========================================================================
// Multipart upload
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
      Array.from({ length: Math.min(PART_CONCURRENCY, partCount) }, worker),
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

async function parseResponse(res) {
  if (res.ok) {
    if (res.status === 204) return {};
    try {
      return await res.json();
    } catch {
      return {};
    }
  }

  let body = {};
  try {
    body = await res.json();
  } catch {
    // Non-JSON error.
  }

  if (res.status === 403 || res.status === 401) {
    const err = new Error("Your session has expired — reload the page to sign in again.");
    err.fatal = true;
    showBanner(err.message, true);
    throw err;
  }

  if (res.status === 409) {
    const existing = body.existing;
    const detail = existing
      ? ` (existing: ${formatBytes(existing.size)}${existing.uploaded ? `, uploaded ${new Date(existing.uploaded).toLocaleString()}` : ""})`
      : "";
    const err = new Error(`An object already exists at that key${detail}`);
    err.fatal = true;
    err.conflict = { key: body.key };
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
  li.className = `row ${item.state}`;

  const state = li.querySelector(".state");
  switch (item.state) {
    case "pending":
      state.textContent = "Ready to upload";
      break;
    case "queued":
      state.textContent = "Queued";
      break;
    case "uploading": {
      const elapsed = (Date.now() - item.startedAt) / 1000;
      const rate = elapsed > 0.5 ? item.loaded / elapsed : 0;
      state.textContent =
        `${pct}% · ${formatBytes(item.loaded)} of ${formatBytes(item.file.size)}` +
        (rate ? ` · ${formatBytes(rate)}/s` : "");
      break;
    }
    case "done":
      state.textContent = "Uploaded";
      break;
    case "cancelled":
      state.textContent = "Cancelled";
      break;
    case "conflict":
    case "error":
      state.textContent = item.message || "Failed";
      break;
  }

  const keyEl = li.querySelector(".key");
  if (item.state === "done" && item.finalKey) {
    keyEl.hidden = false;
    keyEl.textContent = item.finalKey;
  } else {
    keyEl.hidden = true;
  }

  renderActions(item, li.querySelector(".actions"));
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
    add("Cancel", () => cancel(item));
  }

  if (item.state === "error") {
    add("Retry", () => retry(item));
  }

  if (item.state === "conflict") {
    add("Rename", () => rename(item));
    add("Overwrite", () => {
      item.overwrite = true;
      retry(item);
    });
  }

  if (item.state === "done" && item.finalKey) {
    add("Copy key", async () => {
      try {
        await navigator.clipboard.writeText(item.finalKey);
        showBanner(`Copied ${item.finalKey}`);
      } catch {
        showBanner("Could not copy to clipboard.", true);
      }
    });
  }
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

  // Build summary.
  const parts = [];
  if (pendingCount > 0) {
    parts.push(
      `${selectedPendingCount} of ${pendingCount} selected (${formatBytes(selectedPendingSize)} of ${formatBytes(pendingSize)}) → ${currentPrefix || "/"}`,
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

function cancel(item) {
  item.cancelled = true;
  for (const c of item.controllers) c.abort();
  if (item.state === "queued" || item.state === "pending") {
    item.state = "cancelled";
    update(item);
  }
}

function retry(item) {
  item.state = "queued";
  item.message = "";
  item.conflict = null;
  item.loaded = 0;
  update(item);
  pump();
}

function rename(item) {
  const next = prompt("New key for this file:", item.key);
  if (!next) return;
  item.key = next.trim();
  item.overwrite = false;
  retry(item);
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

let bannerTimer;
function showBanner(message, isError = false) {
  els.banner.textContent = message;
  els.banner.className = isError ? "banner error" : "banner";
  els.banner.classList.remove("is-hiding");
  els.banner.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    els.banner.classList.add("is-hiding");
    setTimeout(() => {
      els.banner.hidden = true;
      els.banner.classList.remove("is-hiding");
    }, 300);
  }, 5000);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
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
