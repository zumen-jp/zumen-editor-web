import { isImagePath, isProtectedDrawingOrBimPath } from "./paths";
import { decodeTextBytes, MAX_TEXT_BYTES } from "./text-codec";
import type { WorkspaceFs } from "./types";

export type SearchMatch = {
  path: string;
  line: number;
  column: number;
  preview: string;
  encoding: string;
};

export type SearchResult = {
  query: string;
  matches: SearchMatch[];
  truncated: boolean;
  scannedFiles: number;
};

export async function searchWorkspaceText(
  fs: WorkspaceFs,
  query: string,
  options?: {
    path?: string;
    caseSensitive?: boolean;
    regex?: boolean;
    limit?: number;
  },
): Promise<SearchResult> {
  const trimmed = query;
  if (!trimmed) {
    return { query, matches: [], truncated: false, scannedFiles: 0 };
  }
  const limit = Math.max(1, Math.min(200, options?.limit ?? 80));
  const flags = options?.caseSensitive ? "g" : "gi";
  const matcher = options?.regex
    ? new RegExp(trimmed, flags)
    : new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

  const { files } = await fs.walkFiles(options?.path ?? "", { maxFiles: 1000 });
  const matches: SearchMatch[] = [];
  let scannedFiles = 0;
  let truncated = false;

  for (const entry of files) {
    if (isProtectedDrawingOrBimPath(entry.path) || isImagePath(entry.path)) continue;
    if ((entry.size ?? 0) > MAX_TEXT_BYTES) continue;
    scannedFiles += 1;
    let text: string;
    let encoding: string;
    try {
      const { bytes } = await fs.readBytes(entry.path);
      const decoded = decodeTextBytes(bytes);
      if (!decoded) continue;
      text = decoded.text;
      encoding = decoded.encoding;
    } catch {
      continue;
    }

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] ?? "";
      matcher.lastIndex = 0;
      const hit = matcher.exec(lineText);
      if (!hit) continue;
      matches.push({
        path: entry.path,
        line: i + 1,
        column: hit.index + 1,
        preview: lineText.slice(0, 200),
        encoding,
      });
      if (matches.length >= limit) {
        truncated = true;
        return { query, matches, truncated, scannedFiles };
      }
    }
  }

  return { query, matches, truncated, scannedFiles };
}
