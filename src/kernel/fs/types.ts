import type { DecodedText, TextFormat } from "./text-codec";

export type WorkspaceKind = "fsa" | "opfs" | "memory";

export type FileEntryKind = "file" | "directory";

export type WorkspaceEntry = {
  name: string;
  path: string;
  kind: FileEntryKind;
  size?: number;
  lastModified?: number;
};

export type FileStatInfo = {
  path: string;
  kind: FileEntryKind;
  size: number;
  lastModified: number;
  version: string;
};

export type FileChangeEvent = {
  paths: string[];
  kind: "modified" | "created" | "deleted" | "unknown";
};

export type TextChangeRecord = {
  id: string;
  workspaceId: string;
  path: string;
  beforeText: string | null;
  afterText: string;
  format: TextFormat;
  createdAt: number;
  reverted: boolean;
};

export class WorkspaceConflictError extends Error {
  constructor(
    readonly path: string,
    readonly currentVersion: string,
  ) {
    super(`ファイル「${path}」が外で変更されています。読み直してからやり直してください。`);
    this.name = "WorkspaceConflictError";
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`ファイルまたはフォルダーが見つかりません: ${path}`);
    this.name = "WorkspaceNotFoundError";
  }
}

export interface WorkspaceFs {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkspaceKind;

  listDir(relativeDir: string): Promise<WorkspaceEntry[]>;
  stat(relativePath: string): Promise<FileStatInfo>;
  exists(relativePath: string): Promise<boolean>;
  readBytes(relativePath: string): Promise<{ bytes: Uint8Array; stat: FileStatInfo }>;
  writeBytes(
    relativePath: string,
    bytes: Uint8Array,
    options?: { expectedVersion?: string; create?: boolean },
  ): Promise<FileStatInfo>;
  readText(relativePath: string): Promise<{ decoded: DecodedText; stat: FileStatInfo }>;
  writeText(
    relativePath: string,
    text: string,
    format: TextFormat,
    options?: { expectedVersion?: string; create?: boolean },
  ): Promise<FileStatInfo>;
  mkdir(relativeDir: string): Promise<void>;
  deleteEntry(relativePath: string): Promise<void>;
  renameEntry(fromPath: string, toPath: string): Promise<void>;
  walkFiles(
    relativeDir?: string,
    options?: { maxFiles?: number },
  ): Promise<{ files: WorkspaceEntry[]; truncated: boolean }>;
  subscribeChanges?(listener: (event: FileChangeEvent) => void): () => void;
}
