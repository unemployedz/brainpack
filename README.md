# BrainPack

BrainPack is an Obsidian community plugin for importing complete ZIP archives into the current vault.

## Features

- Extracts regular files with their original names, extensions, and binary contents.
- Preserves nested directory structure.
- Designed for desktop and mobile Obsidian without Node.js filesystem APIs.
- Previews archive contents before importing.
- Detects existing paths and offers skip or replace behavior.
- Checks ZIP CRC32 values and rejects unsafe archive paths.
- Rejects encrypted, multi-volume, and ZIP64 archives.

## Install

The repository is being prepared for beta distribution through BRAT. Once a GitHub release is published:

1. Install BRAT from Obsidian Community Plugins.
2. Run **BRAT: Add a beta plugin for testing**.
3. Enter `unemployedz/brainpack`.
4. Enable BrainPack in Settings → Community plugins.

## Use

Run **Open BrainPack ZIP importer** from the Command Palette or use the ribbon icon. Choose a ZIP, review the preview, select how to handle existing files, and import.

On iOS, choose the ZIP from the Files picker.

## Safety limits

- ZIP archive: 256 MB maximum.
- Individual uncompressed file: 128 MB maximum.
- Total uncompressed content: 512 MB maximum.
- Maximum entries: 5,000.
- Rejects absolute paths, path traversal, encrypted entries, and Unix symlinks.
- Existing files are skipped by default.

## Compatibility

Supports standard ZIP Store (method 0) and Deflate (method 8). ZIP64 and unusual filename encodings are not supported in this first version. Large archives may be constrained by device memory.

## Privacy

Archives are processed locally inside Obsidian. BrainPack does not upload files or send archive contents to a server.

## License

MIT