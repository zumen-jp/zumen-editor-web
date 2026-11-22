import { normalizeRelativePath, parentDirOf, splitPathSegments } from "./paths";
import { decodeTextBytes, encodeTextBytes, MAX_TEXT_BYTES, type TextFormat } from "./text-codec";
import {
  type FileChangeEvent,
  type FileStatInfo,
  WorkspaceConflictError,
  type WorkspaceEntry,
  type WorkspaceFs,
  WorkspaceNotFoundError,
} from "./types";

// Chrome 133+ FileSystemObserver の最小型定義
type FileSystemObserverRecord = {
  type: "appeared" | "disappeared" | "modified" | "moved" | "unknown" | "errored";
  relativePathComponents: string[];
};

type ChromeFileSystemObserver = {
  observe(handle: FileSystemDirectoryHandle, options?: { recursive?: boolean }): Promise<void>;
  disconnect(): void;
};

type ChromeFileSystemObserverCtor = new (
  callback: (records: FileSystemObserverRecord[]) => void,
) => ChromeFileSystemObserver;

function makeVersion(size: number, lastModified: number): string {
  return `${lastModified}:${size}`;
}

export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === "function"
  );
}

export async function pickLocalDirectory(): Promise<FileSystemDirectoryHandle> {
  const picker = (
    window as Window & {
      showDirectoryPicker?: (opts?: {
        mode?: "read" | "readwrite";
      }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (!picker) {
    throw new Error("このブラウザーは Chrome の File System Access API に対応していません。");
  }
  return picker({ mode: "readwrite" });
}

export async function ensureHandleReadWritePermission(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  const h = handle as FileSystemDirectoryHandle & {
    queryPermission?: (desc: { mode: "readwrite" }) => Promise<PermissionState>;
    requestPermission?: (desc: { mode: "readwrite" }) => Promise<PermissionState>;
  };
  if (typeof h.queryPermission === "function") {
    const state = await h.queryPermission({ mode: "readwrite" });
    if (state === "granted") return true;
  }
  if (typeof h.requestPermission === "function") {
    const state = await h.requestPermission({ mode: "readwrite" });
    return state === "granted";
  }
  return true;
}

/**
 * Chrome File System Access API（または OPFS の FileSystemDirectoryHandle）を包む WorkspaceFs。
 * すべての操作は渡されたルート FileSystemDirectoryHandle の配下に限定される。
 */
export class HandleWorkspaceFs implements WorkspaceFs {
  readonly id: string;
  readonly name: string;
  readonly kind: "fsa" | "opfs";
  readonly root: FileSystemDirectoryHandle;

  constructor(params: {
    id: string;
    name: string;
    kind: "fsa" | "opfs";
    root: FileSystemDirectoryHandle;
  }) {
    this.id = params.id;
    this.name = params.name;
    this.kind = params.kind;
    this.root = params.root;
  }

  private async resolveDir(
    relativeDir: string,
    create = false,
  ): Promise<FileSystemDirectoryHandle> {
    const segments = splitPathSegments(relativeDir);
    let current = this.root;
    for (const seg of segments) {
      try {
        current = await current.getDirectoryHandle(seg, { create });
      } catch (err) {
        if ((err as DOMException)?.name === "NotFoundError") {
          throw new WorkspaceNotFoundError(relativeDir);
        }
        throw err;
      }
    }
    return current;
  }

  private async resolveFile(relativePath: string, create = false): Promise<FileSystemFileHandle> {
    const normalized = normalizeRelativePath(relativePath);
    const segments = normalized.split("/");
    const fileName = segments.pop();
    if (!fileName) throw new WorkspaceNotFoundError(relativePath);
    const dir = await this.resolveDir(segments.join("/"), create);
    try {
      return await dir.getFileHandle(fileName, { create });
    } catch (err) {
      if ((err as DOMException)?.name === "NotFoundError") {
        throw new WorkspaceNotFoundError(normalized);
      }
      throw err;
    }
  }

  async listDir(relativeDir: string): Promise<WorkspaceEntry[]> {
    const normalized = normalizeRelativePath(relativeDir, { allowEmpty: true });
    const dir = await this.resolveDir(normalized, false);
    const out: WorkspaceEntry[] = [];
    const iterable = dir as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    };
    for await (const [name, handle] of iterable.entries()) {
      if (name.startsWith(".crswap") || name === ".DS_Store") continue;
      const entryPath = normalized ? `${normalized}/${name}` : name;
      if (handle.kind === "directory") {
        out.push({ name, path: entryPath, kind: "directory" });
      } else {
        const file = await (handle as FileSystemFileHandle).getFile();
        out.push({
          name,
          path: entryPath,
          kind: "file",
          size: file.size,
          lastModified: file.lastModified,
        });
      }
    }
    out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, "ja");
    });
    return out;
  }

  async stat(relativePath: string): Promise<FileStatInfo> {
    const normalized = normalizeRelativePath(relativePath);
    try {
      const fh = await this.resolveFile(normalized, false);
      const file = await fh.getFile();
      return {
        path: normalized,
        kind: "file",
        size: file.size,
        lastModified: file.lastModified,
        version: makeVersion(file.size, file.lastModified),
      };
    } catch (err) {
      if (
        err instanceof WorkspaceNotFoundError ||
        (err as DOMException)?.name === "TypeMismatchError"
      ) {
        await this.resolveDir(normalized, false);
        return { path: normalized, kind: "directory", size: 0, lastModified: 0, version: "dir" };
      }
      throw err;
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await this.stat(relativePath);
      return true;
    } catch {
      return false;
    }
  }

  async readBytes(relativePath: string): Promise<{ bytes: Uint8Array; stat: FileStatInfo }> {
    const normalized = normalizeRelativePath(relativePath);
    const fh = await this.resolveFile(normalized, false);
    const file = await fh.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      bytes,
      stat: {
        path: normalized,
        kind: "file",
        size: file.size,
        lastModified: file.lastModified,
        version: makeVersion(file.size, file.lastModified),
      },
    };
  }

  async writeBytes(
    relativePath: string,
    bytes: Uint8Array,
    options?: { expectedVersion?: string; create?: boolean },
  ): Promise<FileStatInfo> {
    const normalized = normalizeRelativePath(relativePath);
    if (options?.expectedVersion) {
      const current = await this.stat(normalized);
      if (current.version !== options.expectedVersion) {
        throw new WorkspaceConflictError(normalized, current.version);
      }
    }
    const fh = await this.resolveFile(normalized, options?.create !== false);
    const writable = await fh.createWritable();
    try {
      await writable.write(bytes as unknown as BufferSource);
      await writable.close();
    } catch (err) {
      await writable.abort().catch(() => undefined);
      throw err;
    }
    const updated = await fh.getFile();
    return {
      path: normalized,
      kind: "file",
      size: updated.size,
      lastModified: updated.lastModified,
      version: makeVersion(updated.size, updated.lastModified),
    };
  }

  async readText(relativePath: string) {
    const { bytes, stat } = await this.readBytes(relativePath);
    if (bytes.byteLength > MAX_TEXT_BYTES) {
      throw new Error(
        `テキストファイルが大きすぎます（上限 ${MAX_TEXT_BYTES / (1024 * 1024)} MB）。`,
      );
    }
    const decoded = decodeTextBytes(bytes);
    if (!decoded) {
      throw new Error("テキストとして読めないバイナリまたは未対応の文字コードです。");
    }
    return { decoded, stat };
  }

  async writeText(
    relativePath: string,
    text: string,
    format: TextFormat,
    options?: { expectedVersion?: string; create?: boolean },
  ): Promise<FileStatInfo> {
    const bytes = encodeTextBytes(text, format);
    return this.writeBytes(relativePath, bytes, options);
  }

  async mkdir(relativeDir: string): Promise<void> {
    const normalized = normalizeRelativePath(relativeDir);
    await this.resolveDir(normalized, true);
  }

  async deleteEntry(relativePath: string): Promise<void> {
    const normalized = normalizeRelativePath(relativePath);
    const parent = parentDirOf(normalized);
    const name = normalized.slice(parent ? parent.length + 1 : 0);
    const dir = await this.resolveDir(parent, false);
    await dir.removeEntry(name, { recursive: true });
  }

  async renameEntry(fromPath: string, toPath: string): Promise<void> {
    const from = normalizeRelativePath(fromPath);
    const to = normalizeRelativePath(toPath);
    if (from === to) return;
    const info = await this.stat(from);
    if (info.kind === "file") {
      const { bytes } = await this.readBytes(from);
      await this.writeBytes(to, bytes, { create: true });
      await this.deleteEntry(from);
      return;
    }
    // ディレクトリは Chrome の move 非対応環境でも動く再帰コピー＋削除で安全に扱う。
    await this.copyDirRecursive(from, to);
    await this.deleteEntry(from);
  }

  private async copyDirRecursive(fromDir: string, toDir: string): Promise<void> {
    await this.mkdir(toDir);
    const entries = await this.listDir(fromDir);
    for (const entry of entries) {
      const nextTo = `${toDir}/${entry.name}`;
      if (entry.kind === "directory") {
        await this.copyDirRecursive(entry.path, nextTo);
      } else {
        const { bytes } = await this.readBytes(entry.path);
        await this.writeBytes(nextTo, bytes, { create: true });
      }
    }
  }

  async walkFiles(
    relativeDir = "",
    options?: { maxFiles?: number },
  ): Promise<{ files: WorkspaceEntry[]; truncated: boolean }> {
    const maxFiles = options?.maxFiles ?? 2000;
    const files: WorkspaceEntry[] = [];
    let truncated = false;
    const queue = [normalizeRelativePath(relativeDir, { allowEmpty: true })];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const entries = await this.listDir(current);
      for (const entry of entries) {
        if (entry.kind === "directory") {
          if (entry.name === ".git" || entry.name === "node_modules") continue;
          queue.push(entry.path);
        } else {
          if (files.length >= maxFiles) {
            truncated = true;
            return { files, truncated };
          }
          files.push(entry);
        }
      }
    }
    return { files, truncated };
  }

  subscribeChanges(listener: (event: FileChangeEvent) => void): () => void {
    const ObserverCtor = (globalThis as { FileSystemObserver?: ChromeFileSystemObserverCtor })
      .FileSystemObserver;
    if (typeof ObserverCtor === "function") {
      const observer = new ObserverCtor((records) => {
        const paths = records
          .map((r) => r.relativePathComponents.join("/"))
          .filter((p) => p.length > 0);
        if (paths.length > 0) {
          listener({ paths, kind: "modified" });
        }
      });
      void observer.observe(this.root, { recursive: true }).catch(() => undefined);
      return () => observer.disconnect();
    }

    // フォールバック: ウィンドウへ戻った時に再確認イベントを流す
    const onFocus = () => listener({ paths: [], kind: "unknown" });
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
      return () => window.removeEventListener("focus", onFocus);
    }
    return () => undefined;
  }
}
