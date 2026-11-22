// Chrome 標準 DecompressionStream("deflate-raw") を用いた純ブラウザ表リーダー（.xlsx / .csv / .tsv）。
// Node.js 24 でも Web Streams の DecompressionStream が標準利用できるため、テストも同一コードで動作する。

export type SheetCellKind = "text" | "number" | "boolean" | "error" | "empty";

export type SheetCell = {
  row: number;
  column: number;
  kind: SheetCellKind;
  value: string;
  formula?: string;
};

export type SheetArea = {
  firstRow: number;
  lastRow: number;
  firstColumn: number;
  lastColumn: number;
};

export type ParsedSheet = {
  name: string;
  rows: number;
  columns: number;
  cells: SheetCell[];
  merged: SheetArea[];
};

export type ParsedSpreadsheet = {
  format: "xlsx" | "csv" | "tsv";
  encoding?: "utf-8" | "shift_jis" | "utf-16le" | "utf-16be";
  sheets: ParsedSheet[];
  warnings: string[];
};

const MAX_ZIP_ENTRIES = 2048;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_CELLS = 250_000;
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

async function inflateRawBounded(compressed: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const writePromise = writer
    .write(compressed as unknown as BufferSource)
    .then(() => writer.close());

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("展開後のデータ量が上限を超えたため中止しました。");
      }
      chunks.push(value);
    }
    await writePromise;
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

function normalizeZipEntryName(raw: string): string | null {
  const parts: string[] = [];
  for (const seg of raw.replaceAll("\\", "/").replace(/^\/+/, "").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.length > 0 ? parts.join("/") : null;
}

class BrowserZipReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly entries = new Map<string, ZipEntry>();
  private decodedTotal = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.parseCentralDirectory();
  }

  private parseCentralDirectory(): void {
    const len = this.bytes.byteLength;
    if (len < 22) throw new Error("ZIP 構造が壊れています。");
    const minPos = Math.max(0, len - 65_557);
    let eocd = -1;
    for (let p = len - 22; p >= minPos; p--) {
      if (this.view.getUint32(p, true) === EOCD_SIG) {
        const commentLen = this.view.getUint16(p + 20, true);
        if (p + 22 + commentLen <= len) {
          eocd = p;
          break;
        }
      }
    }
    if (eocd < 0) throw new Error("Excel（.xlsx）の ZIP 終端が見つかりません。");

    const count = this.view.getUint16(eocd + 10, true);
    const cdSize = this.view.getUint32(eocd + 12, true);
    const cdOffset = this.view.getUint32(eocd + 16, true);
    if (count > MAX_ZIP_ENTRIES) throw new Error("Excel 内のパート数が上限を超えています。");
    if (cdOffset + cdSize > len) throw new Error("ZIP 中央ディレクトリが範囲外です。");

    const utf8 = new TextDecoder("utf-8", { fatal: false });
    let cursor = cdOffset;
    for (let i = 0; i < count && cursor < cdOffset + cdSize; i++) {
      if (cursor + 46 > len || this.view.getUint32(cursor, true) !== CEN_SIG) {
        throw new Error("ZIP 中央ディレクトリが壊れています。");
      }
      const flags = this.view.getUint16(cursor + 8, true);
      if ((flags & 0x01) !== 0) {
        throw new Error("暗号化された Excel ファイルは読み取れません。");
      }
      const method = this.view.getUint16(cursor + 10, true);
      const compressedSize = this.view.getUint32(cursor + 20, true);
      const uncompressedSize = this.view.getUint32(cursor + 24, true);
      const nameLen = this.view.getUint16(cursor + 28, true);
      const extraLen = this.view.getUint16(cursor + 30, true);
      const commentLen = this.view.getUint16(cursor + 32, true);
      const localOffset = this.view.getUint32(cursor + 42, true);
      const nameStart = cursor + 46;
      const next = nameStart + nameLen + extraLen + commentLen;
      if (next > len) throw new Error("ZIP エントリ名が範囲外です。");
      const name = normalizeZipEntryName(
        utf8.decode(this.bytes.subarray(nameStart, nameStart + nameLen)),
      );
      if (name) {
        this.entries.set(name.toLowerCase(), {
          name,
          method,
          compressedSize,
          uncompressedSize,
          localOffset,
        });
      }
      cursor = next;
    }
  }

  async readText(entryPath: string): Promise<string | null> {
    const normalized = normalizeZipEntryName(entryPath);
    if (!normalized) return null;
    const meta = this.entries.get(normalized.toLowerCase());
    if (!meta) return null;

    const offset = meta.localOffset;
    if (offset + 30 > this.bytes.byteLength || this.view.getUint32(offset, true) !== LOC_SIG) {
      throw new Error("ZIP ローカルヘッダーが壊れています。");
    }
    const nameLen = this.view.getUint16(offset + 26, true);
    const extraLen = this.view.getUint16(offset + 28, true);
    const start = offset + 30 + nameLen + extraLen;
    const end = start + meta.compressedSize;
    if (end > this.bytes.byteLength) throw new Error("ZIP 圧縮データが範囲外です。");

    const remaining = MAX_DECODED_BYTES - this.decodedTotal;
    if (remaining <= 0) throw new Error("展開データ量が上限を超えました。");

    const rawSlice = this.bytes.subarray(start, end);
    let data: Uint8Array;
    if (meta.method === 0) {
      data = rawSlice;
    } else if (meta.method === 8) {
      data = await inflateRawBounded(rawSlice, remaining);
    } else {
      throw new Error(`未対応の ZIP 圧縮方式です（method=${meta.method}）。`);
    }
    this.decodedTotal += data.byteLength;
    return new TextDecoder("utf-8", { fatal: false }).decode(data);
  }
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (full, ent: string) => {
      if (ent === "lt") return "<";
      if (ent === "gt") return ">";
      if (ent === "amp") return "&";
      if (ent === "quot") return '"';
      if (ent === "apos") return "'";
      const cp =
        ent.startsWith("#x") || ent.startsWith("#X")
          ? Number.parseInt(ent.slice(2), 16)
          : Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
    })
    .replace(/_x([0-9a-fA-F]{4})_/g, (m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : m;
    });
}

function parseAttrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const k = m[1];
    if (k) out[k] = decodeXmlEntities(m[2] ?? m[3] ?? "");
  }
  return out;
}

function parseCellCoord(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref.trim());
  if (!m) return null;
  const letters = (m[1] ?? "").toUpperCase();
  const rowNum = Number.parseInt(m[2] ?? "", 10);
  if (!letters || !Number.isFinite(rowNum) || rowNum < 1) return null;
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { row: rowNum - 1, col: col - 1 };
}

function resolveTarget(basePath: string, target: string): string {
  if (target.startsWith("/")) return target.replace(/^\/+/, "");
  const slash = basePath.lastIndexOf("/");
  const dir = slash >= 0 ? basePath.slice(0, slash) : "";
  return normalizeZipEntryName(dir ? `${dir}/${target}` : target) ?? target;
}

function extractRichText(xml: string): string {
  const clean = xml.replace(/<(?:[\w.-]+:)?rPh\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?rPh>/g, "");
  const parts: string[] = [];
  const re = /<(?:[\w.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?t>/g;
  for (let m = re.exec(clean); m !== null; m = re.exec(clean)) {
    parts.push(decodeXmlEntities(m[1] ?? ""));
  }
  return parts.join("");
}

async function parseXlsx(bytes: Uint8Array): Promise<ParsedSpreadsheet> {
  const zip = new BrowserZipReader(bytes);
  const warnings: string[] = [];
  const wbXml = await zip.readText("xl/workbook.xml");
  if (!wbXml) throw new Error("Excel ワークブック定義（xl/workbook.xml）が見つかりません。");

  const relsXml = await zip.readText("xl/_rels/workbook.xml.rels");
  const rels = new Map<string, string>();
  if (relsXml) {
    const re = /<(?:[\w.-]+:)?Relationship\b([^>]*?)\/?>/g;
    for (let m = re.exec(relsXml); m !== null; m = re.exec(relsXml)) {
      const a = parseAttrs(m[1] ?? "");
      if (a.Id && a.Target) rels.set(a.Id, a.Target);
    }
  }

  const sharedStringsXml = await zip.readText("xl/sharedStrings.xml");
  const sharedStrings: string[] = [];
  if (sharedStringsXml) {
    const siRe = /<(?:[\w.-]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?si>/g;
    for (let m = siRe.exec(sharedStringsXml); m !== null; m = siRe.exec(sharedStringsXml)) {
      sharedStrings.push(extractRichText(m[1] ?? ""));
    }
  }

  const sheets: ParsedSheet[] = [];
  let remainingCells = MAX_CELLS;
  const sheetRe = /<(?:[\w.-]+:)?sheet\b([^>]*?)\/?>/g;
  let seq = 0;

  for (let m = sheetRe.exec(wbXml); m !== null; m = sheetRe.exec(wbXml)) {
    const attrs = parseAttrs(m[1] ?? "");
    const name = attrs.name ?? `Sheet${++seq}`;
    const rid = attrs["r:id"] ?? attrs.id;
    const target = rid ? rels.get(rid) : undefined;
    if (!target) {
      warnings.push(`シート「${name}」の参照先が見つかりませんでした。`);
      continue;
    }
    const xml = await zip.readText(resolveTarget("xl/workbook.xml", target));
    if (!xml) {
      warnings.push(`シート「${name}」を読み取れませんでした。`);
      continue;
    }

    const cells: SheetCell[] = [];
    const merged: SheetArea[] = [];
    let maxRow = 0;
    let maxCol = 0;

    const mergeRe = /<(?:[\w.-]+:)?mergeCell\b([^>]*?)\/?>/g;
    for (let mm = mergeRe.exec(xml); mm !== null; mm = mergeRe.exec(xml)) {
      const ref = parseAttrs(mm[1] ?? "").ref;
      if (!ref) continue;
      const [a, b] = ref.split(":");
      const ca = a ? parseCellCoord(a) : null;
      const cb = b ? parseCellCoord(b) : ca;
      if (ca && cb) {
        merged.push({
          firstRow: Math.min(ca.row, cb.row),
          lastRow: Math.max(ca.row, cb.row),
          firstColumn: Math.min(ca.col, cb.col),
          lastColumn: Math.max(ca.col, cb.col),
        });
      }
    }

    const rowRe = /<(?:[\w.-]+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?row>)/g;
    let nextRow = 0;
    for (let rm = rowRe.exec(xml); rm !== null; rm = rowRe.exec(xml)) {
      const rowAttrs = parseAttrs(rm[1] ?? "");
      const explicit = rowAttrs.r ? Number.parseInt(rowAttrs.r, 10) : Number.NaN;
      const rowIdx = Number.isFinite(explicit) && explicit >= 1 ? explicit - 1 : nextRow;
      nextRow = rowIdx + 1;
      const body = rm[2];
      if (!body) continue;

      const cellRe = /<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/g;
      let nextCol = 0;
      for (let cm = cellRe.exec(body); cm !== null; cm = cellRe.exec(body)) {
        const cAttrs = parseAttrs(cm[1] ?? "");
        const coord = cAttrs.r ? parseCellCoord(cAttrs.r) : null;
        const r = coord ? coord.row : rowIdx;
        const c = coord ? coord.col : nextCol;
        nextCol = c + 1;
        const cBody = cm[2] ?? "";
        if (!cBody) continue;

        const fMatch = /<(?:[\w.-]+:)?f\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?f>/.exec(cBody);
        const formula = fMatch?.[1] ? decodeXmlEntities(fMatch[1]).trim() : "";
        const vMatch = /<(?:[\w.-]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?v>/.exec(cBody);
        const isMatch = /<(?:[\w.-]+:)?is\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?is>/.exec(cBody);
        const rawV = vMatch?.[1];
        const t = cAttrs.t ?? "";

        let kind: SheetCellKind = "empty";
        let value = "";
        if (t === "s") {
          const idx = rawV ? Number.parseInt(rawV.trim(), 10) : -1;
          value = idx >= 0 ? (sharedStrings[idx] ?? "") : "";
          kind = value || formula ? "text" : "empty";
        } else if (t === "inlineStr" || isMatch) {
          value = isMatch?.[1] ? extractRichText(isMatch[1]) : "";
          kind = value || formula ? "text" : "empty";
        } else if (t === "str") {
          value = rawV ? decodeXmlEntities(rawV) : "";
          kind = value || formula ? "text" : "empty";
        } else if (t === "b") {
          value = rawV?.trim() === "1" || rawV?.trim().toLowerCase() === "true" ? "true" : "false";
          kind = rawV !== undefined ? "boolean" : "empty";
        } else if (t === "e") {
          value = rawV ? decodeXmlEntities(rawV).trim() : "";
          kind = value ? "error" : "empty";
        } else if (rawV && rawV.trim() !== "") {
          value = decodeXmlEntities(rawV).trim();
          kind = t === "" || t === "n" ? "number" : "text";
        }

        if (kind === "empty" && !formula) continue;
        if (remainingCells <= 0) {
          warnings.push(`セル数が上限（${MAX_CELLS}）を超えたため残りを省略しました。`);
          break;
        }
        remainingCells -= 1;
        cells.push({ row: r, column: c, kind, value, ...(formula ? { formula } : {}) });
        maxRow = Math.max(maxRow, r + 1);
        maxCol = Math.max(maxCol, c + 1);
      }
    }

    sheets.push({ name, rows: maxRow, columns: maxCol, cells, merged });
  }

  return { format: "xlsx", sheets, warnings };
}

function parseDelimited(bytes: Uint8Array, format: "csv" | "tsv"): ParsedSpreadsheet {
  let encoding: ParsedSpreadsheet["encoding"] = "utf-8";
  let text: string;
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    text = new TextDecoder("utf-8").decode(bytes.subarray(3));
  } else if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    text = new TextDecoder("utf-16le").decode(bytes.subarray(2));
  } else if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    text = new TextDecoder("utf-16be").decode(bytes.subarray(2));
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      encoding = "shift_jis";
      text = new TextDecoder("shift_jis", { fatal: false }).decode(bytes);
    }
  }

  const sep = format === "tsv" ? "\t" : ",";
  const cells: SheetCell[] = [];
  const warnings: string[] = [];
  const numRe = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

  let row = 0;
  let col = 0;
  let maxRow = 0;
  let maxCol = 0;
  let field = "";
  let inQuotes = false;
  let quoted = false;

  const commit = () => {
    if (field !== "" || quoted) {
      if (cells.length < MAX_CELLS && field !== "") {
        const kind: SheetCellKind = !quoted && numRe.test(field) ? "number" : "text";
        cells.push({ row, column: col, kind, value: field });
      }
      maxRow = Math.max(maxRow, row + 1);
      maxCol = Math.max(maxCol, col + 1);
    }
    field = "";
    quoted = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (field === "" && !quoted && ch === '"') {
      inQuotes = true;
      quoted = true;
      continue;
    }
    if (ch === sep) {
      commit();
      col += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      commit();
      row += 1;
      col = 0;
      continue;
    }
    field += ch;
  }
  if (field !== "" || quoted) commit();
  if (inQuotes) warnings.push("閉じられていない引用符が末尾にあります。");

  return {
    format,
    encoding,
    sheets: [{ name: format.toUpperCase(), rows: maxRow, columns: maxCol, cells, merged: [] }],
    warnings,
  };
}

export async function parseSpreadsheetBytes(
  bytes: Uint8Array,
  extension?: string,
): Promise<ParsedSpreadsheet> {
  const isZip =
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05);
  if (isZip || extension?.toLowerCase() === "xlsx") {
    return parseXlsx(bytes);
  }
  return parseDelimited(bytes, extension?.toLowerCase() === "tsv" ? "tsv" : "csv");
}
