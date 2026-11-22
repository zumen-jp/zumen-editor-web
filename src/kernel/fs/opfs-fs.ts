import { HandleWorkspaceFs } from "./fsa-fs";
import { normalizeRelativePath } from "./paths";
import { decodeTextBytes, encodeTextBytes, MAX_TEXT_BYTES, type TextFormat } from "./text-codec";
import {
  type FileStatInfo,
  WorkspaceConflictError,
  type WorkspaceEntry,
  type WorkspaceFs,
  WorkspaceNotFoundError,
} from "./types";

const OPFS_WORKSPACE_DIR = "zumen-editor-workspace";
const OPFS_BACKUP_DIR = "zumen-editor-backups";
const MAX_BACKUP_GENERATIONS = 20;

export async function openOpfsWorkspace(): Promise<HandleWorkspaceFs> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    throw new Error("このブラウザーは OPFS（Origin Private File System）に対応していません。");
  }
  const opfsRoot = await navigator.storage.getDirectory();
  const dir = await opfsRoot.getDirectoryHandle(OPFS_WORKSPACE_DIR, { create: true });
  return new HandleWorkspaceFs({
    id: "opfs:default",
    name: "ブラウザ一時領域（OPFS）",
    kind: "opfs",
    root: dir,
  });
}

export type BackupEntryInfo = {
  id: string;
  createdAt: number;
  size: number;
};

function sanitizeBackupKey(workspaceId: string, relativePath: string): string {
  const combined = `${workspaceId}__${normalizeRelativePath(relativePath)}`;
  return combined.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
}

/**
 * 図面上書き保存・削除前の直前ファイルを OPFS に最大 20 世代保存する控えストア。
 */
export class OpfsBackupStore {
  async saveBackup(
    workspaceId: string,
    relativePath: string,
    bytes: Uint8Array,
  ): Promise<BackupEntryInfo | null> {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
    try {
      const root = await navigator.storage.getDirectory();
      const backupsRoot = await root.getDirectoryHandle(OPFS_BACKUP_DIR, { create: true });
      const keyDir = await backupsRoot.getDirectoryHandle(
        sanitizeBackupKey(workspaceId, relativePath),
        { create: true },
      );
      const ts = Date.now();
      const id = `${ts}-${crypto.randomUUID().slice(0, 8)}`;
      const fh = await keyDir.getFileHandle(id, { create: true });
      const writable = await fh.createWritable();
      await writable.write(bytes as unknown as BufferSource);
      await writable.close();

      await this.prune(keyDir);
      return { id, createdAt: ts, size: bytes.byteLength };
    } catch {
      return null;
    }
  }

  async listBackups(workspaceId: string, relativePath: string): Promise<BackupEntryInfo[]> {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return [];
    try {
      const root = await navigator.storage.getDirectory();
      const backupsRoot = await root.getDirectoryHandle(OPFS_BACKUP_DIR, { create: false });
      const keyDir = await backupsRoot.getDirectoryHandle(
        sanitizeBackupKey(workspaceId, relativePath),
        { create: false },
      );
      const out: BackupEntryInfo[] = [];
      const iterable = keyDir as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      };
      for await (const [name, handle] of iterable.entries()) {
        if (handle.kind !== "file") continue;
        const file = await (handle as FileSystemFileHandle).getFile();
        const ts = Number.parseInt(name.split("-")[0] ?? "", 10);
        out.push({
          id: name,
          createdAt: Number.isFinite(ts) ? ts : file.lastModified,
          size: file.size,
        });
      }
      out.sort((a, b) => b.createdAt - a.createdAt);
      return out;
    } catch {
      return [];
    }
  }

  async readBackup(
    workspaceId: string,
    relativePath: string,
    backupId: string,
  ): Promise<Uint8Array | null> {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
    try {
      const root = await navigator.storage.getDirectory();
      const backupsRoot = await root.getDirectoryHandle(OPFS_BACKUP_DIR, { create: false });
      const keyDir = await backupsRoot.getDirectoryHandle(
        sanitizeBackupKey(workspaceId, relativePath),
        { create: false },
      );
      const fh = await keyDir.getFileHandle(backupId, { create: false });
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  private async prune(keyDir: FileSystemDirectoryHandle): Promise<void> {
    const names: string[] = [];
    const iterable = keyDir as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    };
    for await (const [name, handle] of iterable.entries()) {
      if (handle.kind === "file") names.push(name);
    }
    names.sort();
    while (names.length > MAX_BACKUP_GENERATIONS) {
      const oldest = names.shift();
      if (oldest) await keyDir.removeEntry(oldest).catch(() => undefined);
    }
  }
}

/**
 * 単体テストや非ブラウザ検証で使うメモリ内 WorkspaceFs。
 */
export class MemoryWorkspaceFs implements WorkspaceFs {
  readonly id: string;
  readonly name: string;
  readonly kind = "memory" as const;
  private readonly files = new Map<string, { bytes: Uint8Array; lastModified: number }>();
  private readonly dirs = new Set<string>([""]);
  private tick = 1;

  constructor(initial?: Record<string, string | Uint8Array>, name = "memory-workspace") {
    this.id = `memory:${name}`;
    this.name = name;
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        const normalized = normalizeRelativePath(k);
        this.ensureParentDirs(normalized);
        const bytes = typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v);
        this.files.set(normalized, { bytes, lastModified: ++this.tick });
      }
    }
  }

  private ensureParentDirs(filePath: string): void {
    const parts = filePath.split("/");
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : (parts[i] ?? "");
      this.dirs.add(acc);
    }
  }

  async listDir(relativeDir: string): Promise<WorkspaceEntry[]> {
    const dir = normalizeRelativePath(relativeDir, { allowEmpty: true });
    if (!this.dirs.has(dir)) throw new WorkspaceNotFoundError(dir);
    const prefix = dir ? `${dir}/` : "";
    const seenDirs = new Set<string>();
    const out: WorkspaceEntry[] = [];

    for (const d of this.dirs) {
      if (!d || d === dir || !d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      const first = rest.split("/")[0];
      if (first && !seenDirs.has(first)) {
        seenDirs.add(first);
        out.push({ name: first, path: `${prefix}${first}`, kind: "directory" });
      }
    }
    for (const [p, entry] of this.files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes("/")) continue;
      out.push({
        name: rest,
        path: p,
        kind: "file",
        size: entry.bytes.byteLength,
        lastModified: entry.lastModified,
      });
    }
    out.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "directory" ? -1 : 1) : a.name.localeCompare(b.name, "ja"),
    );
    return out;
  }

  async stat(relativePath: string): Promise<FileStatInfo> {
    const p = normalizeRelativePath(relativePath);
    const file = this.files.get(p);
    if (file) {
      return {
        path: p,
        kind: "file",
        size: file.bytes.byteLength,
        lastModified: file.lastModified,
        version: `${file.lastModified}:${file.bytes.byteLength}`,
      };
    }
    if (this.dirs.has(p)) {
      return { path: p, kind: "directory", size: 0, lastModified: 0, version: "dir" };
    }
    throw new WorkspaceNotFoundError(p);
  }

  async exists(relativePath: string): Promise<boolean> {
    const p = normalizeRelativePath(relativePath);
    return this.files.has(p) || this.dirs.has(p);
  }

  async readBytes(relativePath: string): Promise<{ bytes: Uint8Array; stat: FileStatInfo }> {
    const p = normalizeRelativePath(relativePath);
    const file = this.files.get(p);
    if (!file) throw new WorkspaceNotFoundError(p);
    return {
      bytes: new Uint8Array(file.bytes),
      stat: await this.stat(p),
    };
  }

  async writeBytes(
    relativePath: string,
    bytes: Uint8Array,
    options?: { expectedVersion?: string; create?: boolean },
  ): Promise<FileStatInfo> {
    const p = normalizeRelativePath(relativePath);
    if (options?.expectedVersion) {
      const current = await this.stat(p);
      if (current.version !== options.expectedVersion) {
        throw new WorkspaceConflictError(p, current.version);
      }
    }
    if (options?.create === false && !this.files.has(p)) {
      throw new WorkspaceNotFoundError(p);
    }
    this.ensureParentDirs(p);
    this.files.set(p, { bytes: new Uint8Array(bytes), lastModified: ++this.tick });
    return this.stat(p);
  }

  async readText(relativePath: string) {
    const { bytes, stat } = await this.readBytes(relativePath);
    if (bytes.byteLength > MAX_TEXT_BYTES) {
      throw new Error("テキストファイルが大きすぎます。");
    }
    const decoded = decodeTextBytes(bytes);
    if (!decoded) throw new Error("テキストとして読めないファイルです。");
    return { decoded, stat };
  }

  async writeText(
    relativePath: string,
    text: string,
    format: TextFormat,
    options?: { expectedVersion?: string; create?: boolean },
  ): Promise<FileStatInfo> {
    return this.writeBytes(relativePath, encodeTextBytes(text, format), options);
  }

  async mkdir(relativeDir: string): Promise<void> {
    const p = normalizeRelativePath(relativeDir);
    this.ensureParentDirs(`${p}/_`);
    this.dirs.add(p);
  }

  async deleteEntry(relativePath: string): Promise<void> {
    const p = normalizeRelativePath(relativePath);
    if (this.files.delete(p)) return;
    if (!this.dirs.has(p)) throw new WorkspaceNotFoundError(p);
    const prefix = `${p}/`;
    for (const k of [...this.files.keys()]) {
      if (k.startsWith(prefix)) this.files.delete(k);
    }
    for (const d of [...this.dirs]) {
      if (d === p || d.startsWith(prefix)) this.dirs.delete(d);
    }
  }

  async renameEntry(fromPath: string, toPath: string): Promise<void> {
    const from = normalizeRelativePath(fromPath);
    const to = normalizeRelativePath(toPath);
    if (from === to) return;
    const file = this.files.get(from);
    if (file) {
      this.ensureParentDirs(to);
      this.files.set(to, { bytes: file.bytes, lastModified: ++this.tick });
      this.files.delete(from);
      return;
    }
    if (!this.dirs.has(from)) throw new WorkspaceNotFoundError(from);
    const prefix = `${from}/`;
    this.mkdir(to);
    for (const [k, v] of [...this.files.entries()]) {
      if (k.startsWith(prefix)) {
        const next = `${to}/${k.slice(prefix.length)}`;
        this.ensureParentDirs(next);
        this.files.set(next, v);
        this.files.delete(k);
      }
    }
    for (const d of [...this.dirs]) {
      if (d === from || d.startsWith(prefix)) this.dirs.delete(d);
    }
  }

  async walkFiles(
    relativeDir = "",
    options?: { maxFiles?: number },
  ): Promise<{ files: WorkspaceEntry[]; truncated: boolean }> {
    const maxFiles = options?.maxFiles ?? 2000;
    const base = normalizeRelativePath(relativeDir, { allowEmpty: true });
    const prefix = base ? `${base}/` : "";
    const out: WorkspaceEntry[] = [];
    for (const [p, entry] of [...this.files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (prefix && !p.startsWith(prefix)) continue;
      if (out.length >= maxFiles) return { files: out, truncated: true };
      const name = p.slice(p.lastIndexOf("/") + 1);
      out.push({
        name,
        path: p,
        kind: "file",
        size: entry.bytes.byteLength,
        lastModified: entry.lastModified,
      });
    }
    return { files: out, truncated: false };
  }
}
