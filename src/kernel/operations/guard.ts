import {
  isProtectedDrawingOrBimPath,
  normalizeRelativePath,
  PathValidationError,
} from "../fs/paths";
import { OperationError } from "./types";

/**
 * ツール引数のパスを正規化し、作業フォルダー外参照を確実に遮断する。
 */
export function guardWorkspacePath(rawPath: string, options?: { allowEmpty?: boolean }): string {
  try {
    return normalizeRelativePath(rawPath, options);
  } catch (error) {
    if (error instanceof PathValidationError) {
      throw new OperationError("forbidden", error.message);
    }
    throw new OperationError("bad_request", "パスが不正です。");
  }
}

/**
 * テキスト編集・書き込みツールで図面や IFC を直接書き換えようとする呼び出しを拒否する。
 */
export function guardTextWriteTarget(rawPath: string): string {
  const path = guardWorkspacePath(rawPath);
  if (isProtectedDrawingOrBimPath(path)) {
    throw new OperationError(
      "protected_file",
      `図面または BIM ファイル（${path}）はテキストツールで直接書き換えられません。図面の変更は drawing_propose を使ってください。`,
    );
  }
  return path;
}
