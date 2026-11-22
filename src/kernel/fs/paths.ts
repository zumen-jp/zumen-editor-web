export class PathValidationError extends Error {
  constructor(
    readonly code: "invalid_path" | "outside_workspace" | "protected_file",
    message: string,
  ) {
    super(message);
    this.name = "PathValidationError";
  }
}

const RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

const DRAWING_EXTENSIONS = new Set(["dxf", "dwg", "jww", "sfc", "p21", "sfz", "p2z"]);
const BIM_EXTENSIONS = new Set(["ifc", "ifczip"]);
const SPREADSHEET_EXTENSIONS = new Set(["xlsx", "csv", "tsv"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"]);

/**
 * 作業フォルダー内の相対パス（`/` 区切り）を検証して正規化する。
 * 絶対パス・`..`・制御文字・Windows 予約名は拒否する。
 */
export function normalizeRelativePath(raw: string, options?: { allowEmpty?: boolean }): string {
  const trimmed = raw.trim().replaceAll("\\", "/");
  if (trimmed === "" || trimmed === ".") {
    if (options?.allowEmpty) return "";
    throw new PathValidationError(
      "invalid_path",
      "ファイルまたはフォルダーのパスを指定してください。",
    );
  }
  if (
    trimmed.startsWith("/") ||
    /^[A-Za-z]:/.test(trimmed) ||
    trimmed.includes("\0") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject ASCII control characters in file paths
    /[\x00-\x1f]/.test(trimmed)
  ) {
    throw new PathValidationError(
      "outside_workspace",
      "作業フォルダーの外または不正なパスは指定できません。",
    );
  }

  const parts: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new PathValidationError(
        "outside_workspace",
        "作業フォルダーの外（..）を参照するパスは指定できません。",
      );
    }
    if (segment.endsWith(" ") || segment.endsWith(".")) {
      throw new PathValidationError("invalid_path", `不正な名前です: ${segment}`);
    }
    const base = segment.split(".")[0]?.toLowerCase() ?? "";
    if (RESERVED_NAMES.has(base)) {
      throw new PathValidationError("invalid_path", `OS 予約名は使えません: ${segment}`);
    }
    parts.push(segment);
  }

  if (parts.length === 0) {
    if (options?.allowEmpty) return "";
    throw new PathValidationError("invalid_path", "有効な相対パスを指定してください。");
  }
  return parts.join("/");
}

export function splitPathSegments(relativePath: string): string[] {
  const normalized = normalizeRelativePath(relativePath, { allowEmpty: true });
  return normalized ? normalized.split("/") : [];
}

export function baseNameOf(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

export function parentDirOf(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(0, idx) : "";
}

export function extensionOf(filePath: string): string {
  const clean = filePath.replaceAll("\\", "/");
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isDrawingPath(filePath: string): boolean {
  return DRAWING_EXTENSIONS.has(extensionOf(filePath));
}

export function isBimPath(filePath: string): boolean {
  return BIM_EXTENSIONS.has(extensionOf(filePath));
}

/** テキストツールでの直接書き換えを禁じる図面・BIM 形式か。 */
export function isProtectedDrawingOrBimPath(filePath: string): boolean {
  return isDrawingPath(filePath) || isBimPath(filePath);
}

export function isSpreadsheetPath(filePath: string): boolean {
  return SPREADSHEET_EXTENSIONS.has(extensionOf(filePath));
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(filePath));
}

export function classifyFileKind(filePath: string): "drawing" | "spreadsheet" | "image" | "text" {
  if (isDrawingPath(filePath)) return "drawing";
  if (isSpreadsheetPath(filePath)) return "spreadsheet";
  if (isImagePath(filePath)) return "image";
  return "text";
}
