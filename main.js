const { Plugin, Modal, Notice, Platform } = require("obsidian");

const LIMITS = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxSingleFileBytes: 128 * 1024 * 1024,
  maxEntries: 5000,
};

const TEXT_EXTENSIONS = new Set((
  "txt md mdx markdown rst adoc asciidoc org " +
  "js mjs cjs jsx ts mts cts tsx py pyw pyx pyi rs go mod sum " +
  "c h cc cpp cxx hpp hxx hh inl cs fs fsx fsi vb java kt kts scala sc clj cljs cljc edn groovy gradle " +
  "swift m mm rb rake gemspec php phtml php3 php4 php5 phps html htm xhtml css scss sass less styl vue svelte astro " +
  "json jsonc json5 jsonl yaml yml toml ini cfg conf config env properties xml xsd xsl xslt dtd svg " +
  "sh bash zsh fish ps1 psm1 psc1 bat cmd sql mysql pgsql plsql graphql gql proto dart lua r rmd jl pl pm t cl hs lhs elm ex exs e erl hrl " +
  "ml mli fth forth factor sol vy move cairo circom tf tfvars hcl nix dockerfile make mk cmake gitignore gitattributes editorconfig prettierrc babelrc npmrc nvmrc csv tsv tex bib ipynb diff patch log"
).split(/\s+/));

const CODE_EXTENSIONS = new Set((
  "js mjs cjs jsx ts mts cts tsx py pyw pyx pyi rs go c h cc cpp cxx hpp hxx hh cs fs fsx fsi vb java kt kts scala sc clj cljs cljc groovy swift m mm rb php dart lua r jl pl hs lhs elm ex exs e erl ml mli sol vy move cairo html htm xhtml css scss sass less styl vue svelte astro sql sh bash zsh fish ps1 graphql gql proto tf tfvars hcl nix dockerfile make mk cmake"
).split(/\s+/));

function fileExtension(path) {
  const name = path.split("/").pop().toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}
function isTextExtension(path) { return TEXT_EXTENSIONS.has(fileExtension(path)); }
function isCodeExtension(path) { return CODE_EXTENSIONS.has(fileExtension(path)); }

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeArchivePath(rawName) {
  if (!rawName || rawName.includes("\0")) return null;
  const normalized = rawName.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return null;
  const isDirectory = normalized.endsWith("/");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  const path = parts.join("/");
  if (path.length > 1024) return null;
  return { path, isDirectory };
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This Obsidian environment does not support ZIP decompression. Update Obsidian/iOS and try again.");
  }
  let stream;
  try {
    stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  } catch (error) {
    throw new Error("This device cannot open this ZIP compression format: " + error.message);
  }
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(file) {
  if (file.size > LIMITS.maxArchiveBytes) throw new Error("ZIP is too large. The current limit is 256 MB.");
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const minEOCD = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minEOCD; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      const commentLength = view.getUint16(i + 20, true);
      if (i + 22 + commentLength <= bytes.length) { eocd = i; break; }
    }
  }
  if (eocd < 0) throw new Error("This does not look like a valid ZIP archive.");
  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw new Error("Multi-volume ZIP archives are not supported.");
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported in this version.");
  if (entryCount > LIMITS.maxEntries) throw new Error("This archive contains too many entries. Limit: 5,000.");
  if (centralOffset + centralSize > buffer.byteLength) throw new Error("The ZIP directory is damaged or incomplete.");

  const entries = [];
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > buffer.byteLength || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("The ZIP directory contains an invalid entry.");
    const madeBy = view.getUint16(cursor + 4, true);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > buffer.byteLength) throw new Error("The ZIP directory is truncated.");
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const rawName = new TextDecoder("utf-8", { fatal: false }).decode(nameBytes);
    const safe = safeArchivePath(rawName);
    if (diskStart !== 0) throw new Error("Multi-volume ZIP archives are not supported.");
    if (flags & 0x0001) throw new Error("Password-protected ZIP files are not supported.");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("ZIP64 entries are not supported in this version.");
    const hostSystem = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    const unixType = unixMode & 0xf000;
    const isSymlink = hostSystem === 3 && unixType === 0xa000;
    if (safe && !safe.isDirectory && !isSymlink) {
      if (uncompressedSize > LIMITS.maxSingleFileBytes) throw new Error("A file exceeds the 128 MB per-file safety limit: " + safe.path);
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > LIMITS.maxTotalUncompressedBytes) throw new Error("The uncompressed archive exceeds the 512 MB safety limit.");
      if (method !== 0 && method !== 8) throw new Error("Unsupported ZIP compression method " + method + " in " + safe.path);
      entries.push({ path: safe.path, method, flags, expectedCrc, compressedSize, uncompressedSize, localOffset });
    }
    cursor = recordEnd;
  }
  if (!entries.length) throw new Error("No regular files were found in this ZIP.");
  return { entries, buffer, view, bytes, totalUncompressed };
}

async function extractEntry(zip, entry) {
  const { view, bytes } = zip;
  const offset = entry.localOffset;
  if (offset + 30 > bytes.length || view.getUint32(offset, true) !== 0x04034b50) throw new Error("Invalid local ZIP header: " + entry.path);
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) throw new Error("Truncated file data: " + entry.path);
  const compressed = bytes.subarray(dataStart, dataEnd);
  const output = entry.method === 0 ? compressed.slice() : await inflateRaw(compressed);
  if (output.byteLength !== entry.uncompressedSize) throw new Error("File size check failed: " + entry.path);
  if (crc32(output) !== entry.expectedCrc) throw new Error("Integrity check failed (CRC): " + entry.path);
  return output;
}

function exactArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function ensureFolder(vault, folderPath) {
  if (!folderPath) return;
  const parts = folderPath.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? current + "/" + part : part;
    const existing = vault.getAbstractFileByPath(current);
    if (!existing) await vault.createFolder(current);
    else if (existing.children === undefined) throw new Error("A file blocks the folder path: " + current);
  }
}

class BrainPackModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.archive = null;
    this.zip = null;
    this.cancelled = false;
    this.busy = false;
  }
  onOpen() { this.renderStart(); }
  onClose() { this.cancelled = true; this.contentEl.empty(); }

  renderStart() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("brainpack-modal");
    contentEl.createEl("h2", { text: "BrainPack" });
    contentEl.createEl("p", {
      text: "Import a complete ZIP archive into this vault. All regular file extensions and nested folders are preserved.",
      cls: "brainpack-subtitle",
    });
    const picker = contentEl.createEl("input", { type: "file", attr: { accept: ".zip,application/zip,application/x-zip-compressed" } });
    picker.addClass("brainpack-hidden-input");
    picker.addEventListener("change", async () => {
      const file = picker.files && picker.files[0];
      if (file) await this.loadArchive(file);
    });
    const drop = contentEl.createDiv({ cls: "brainpack-drop" });
    drop.createEl("div", { text: "Choose a ZIP archive", cls: "brainpack-drop-title" });
    drop.createEl("div", { text: "ZIP files up to 256 MB", cls: "brainpack-muted" });
    const choose = drop.createEl("button", { text: "Browse files", cls: "mod-cta" });
    choose.addEventListener("click", () => picker.click());
    if (!Platform.isMobile) {
      drop.addEventListener("dragover", (event) => { event.preventDefault(); drop.addClass("brainpack-dragover"); });
      drop.addEventListener("dragleave", () => drop.removeClass("brainpack-dragover"));
      drop.addEventListener("drop", async (event) => {
        event.preventDefault();
        drop.removeClass("brainpack-dragover");
        const file = event.dataTransfer && event.dataTransfer.files[0];
        if (file) await this.loadArchive(file);
      });
    }
    contentEl.createEl("p", {
      text: "Supported: standard ZIP archives using Store or Deflate compression. Encrypted and ZIP64 archives are not supported yet.",
      cls: "brainpack-footnote",
    });
  }

  async loadArchive(file) {
    if (!file.name.toLowerCase().endsWith(".zip")) { new Notice("Please choose a .zip archive."); return; }
    this.archive = file;
    this.renderLoading("Reading archive…");
    try {
      this.zip = await readZip(file);
      if (this.cancelled) return;
      this.renderPreview();
    } catch (error) {
      this.renderStart();
      new Notice("BrainPack: " + error.message, 8000);
    }
  }

  renderLoading(message) {
    this.contentEl.empty();
    this.contentEl.addClass("brainpack-modal");
    this.contentEl.createEl("h2", { text: "BrainPack" });
    this.contentEl.createEl("p", { text: message, cls: "brainpack-muted" });
  }

  renderPreview() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("brainpack-modal");
    contentEl.createEl("h2", { text: "Import preview" });
    contentEl.createEl("p", {
      text: this.archive.name + " · " + this.zip.entries.length + " files · " + formatBytes(this.zip.totalUncompressed),
      cls: "brainpack-subtitle",
    });
    const conflicts = this.zip.entries.filter((entry) => this.app.vault.getAbstractFileByPath(entry.path)).length;
    contentEl.createEl("p", {
      text: conflicts ? conflicts + " existing paths detected." : "No existing file paths detected.",
      cls: conflicts ? "brainpack-warning" : "brainpack-success",
    });
    const codeCount = this.zip.entries.filter((entry) => isCodeExtension(entry.path)).length;
    const textCount = this.zip.entries.filter((entry) => isTextExtension(entry.path)).length;
    contentEl.createEl("p", {
      text: codeCount + " recognized code files · " + textCount + " text-based files. Other extensions are still imported as binary files.",
      cls: "brainpack-success",
    });
    const list = contentEl.createDiv({ cls: "brainpack-preview-list" });
    const preview = this.zip.entries.slice(0, 12);
    for (const entry of preview) {
      const row = list.createDiv({ cls: "brainpack-preview-row" });
      row.createEl("span", { text: entry.path, cls: "brainpack-preview-name" });
      row.createEl("span", { text: (isCodeExtension(entry.path) ? "CODE · " : isTextExtension(entry.path) ? "TEXT · " : "FILE · ") + formatBytes(entry.uncompressedSize), cls: "brainpack-muted" });
    }
    if (this.zip.entries.length > preview.length) list.createEl("div", {
      text: "And " + (this.zip.entries.length - preview.length) + " more files…",
      cls: "brainpack-muted",
    });
    const options = contentEl.createDiv({ cls: "brainpack-options" });
    options.createEl("label", { text: "If a file already exists" });
    const select = options.createEl("select");
    select.createEl("option", { value: "skip", text: "Skip existing files (safe default)" });
    select.createEl("option", { value: "replace", text: "Replace existing files" });
    const progress = contentEl.createEl("progress", { cls: "brainpack-progress" });
    progress.max = this.zip.entries.length;
    progress.value = 0;
    const status = contentEl.createEl("div", { text: "Ready to import.", cls: "brainpack-status" });
    const actions = contentEl.createDiv({ cls: "brainpack-actions" });
    const back = actions.createEl("button", { text: "Choose another ZIP" });
    back.addEventListener("click", () => this.renderStart());
    const start = actions.createEl("button", { text: "Import " + this.zip.entries.length + " files", cls: "mod-cta" });
    start.addEventListener("click", async () => {
      if (this.busy) return;
      this.busy = true;
      start.disabled = true;
      back.disabled = true;
      select.disabled = true;
      await this.runImport(select.value, progress, status, start, back, select);
    });
  }

  async runImport(conflictMode, progress, status, start, back, select) {
    let imported = 0, skipped = 0, failed = 0;
    try {
      for (let i = 0; i < this.zip.entries.length; i++) {
        if (this.cancelled) break;
        const entry = this.zip.entries[i];
        status.setText("Importing " + (i + 1) + " of " + this.zip.entries.length + ": " + entry.path);
        progress.value = i;
        try {
          const bytes = await extractEntry(this.zip, entry);
          let textContent = null;
          if (isTextExtension(entry.path)) {
            try { textContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
            catch (_) { textContent = null; }
          }
          const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
          await ensureFolder(this.app.vault, parent);
          const existing = this.app.vault.getAbstractFileByPath(entry.path);
          if (existing) {
            if (conflictMode === "replace" && existing.children === undefined) {
              if (textContent !== null) await this.app.vault.modify(existing, textContent);
              else await this.app.vault.modifyBinary(existing, exactArrayBuffer(bytes));
              imported++;
            } else skipped++;
          } else {
            if (textContent !== null) await this.app.vault.create(entry.path, textContent);
            else await this.app.vault.createBinary(entry.path, exactArrayBuffer(bytes));
            imported++;
          }
        } catch (error) {
          failed++;
          console.error("BrainPack import error:", entry.path, error);
        }
        progress.value = i + 1;
      }
      const summary = "Imported " + imported + " · skipped " + skipped + " · failed " + failed;
      status.setText(this.cancelled ? "Cancelled. " + summary : "Finished. " + summary);
      new Notice("BrainPack: " + summary, 8000);
      start.setText("Import complete");
      back.disabled = false;
      select.disabled = false;
    } catch (error) {
      status.setText("Import stopped: " + error.message);
      new Notice("BrainPack: " + error.message, 8000);
      start.disabled = false;
      back.disabled = false;
      select.disabled = false;
    } finally { this.busy = false; }
  }
}

function formatBytes(value) {
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}

module.exports = class BrainPackPlugin extends Plugin {
  onload() {
    this.addCommand({
      id: "open-brainpack-importer",
      name: "Open BrainPack ZIP importer",
      callback: () => new BrainPackModal(this.app, this).open(),
    });
    this.addRibbonIcon("package-open", "Open BrainPack ZIP importer", () => {
      new BrainPackModal(this.app, this).open();
    });
  }
};
