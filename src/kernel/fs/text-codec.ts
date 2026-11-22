// UTF-8・Shift_JIS・UTF-16LE/BE の文字コード・BOM・改行コードを保つ純粋 Web 標準コーデック。

export type TextEncoding = "utf-8" | "shift_jis" | "utf-16le" | "utf-16be";
export type Eol = "lf" | "crlf";

export type TextFormat = {
  encoding: TextEncoding;
  eol: Eol;
  bom: boolean;
};

export type DecodedText = TextFormat & {
  text: string;
  declared?: string;
  mismatch?: boolean;
  lossy?: boolean;
};

export type UnencodableChar = {
  char: string;
  codePoint: number;
  line: number;
  column: number;
  suggestion?: string;
};

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const XML_DECL =
  /^\uFEFF?<\?xml[ \t\r\n][^>]*?\bencoding[ \t\r\n]*=[ \t\r\n]*(["'])([A-Za-z][A-Za-z0-9._-]*)\1/;

const SJIS_SUGGESTIONS: ReadonlyMap<number, string> = new Map([
  [0x301c, "～"],
  [0x2016, "∥"],
  [0x2212, "－"],
  [0x2014, "―"],
  [0x00a2, "￠"],
  [0x00a3, "￡"],
  [0x00ac, "￢"],
  [0x00a5, "￥"],
  [0x203e, "￣"],
  [0x00a0, " "],
]);

let cachedSjisTable: Map<number, number> | null = null;

function buildSjisEncodeTable(): Map<number, number> {
  if (cachedSjisTable) return cachedSjisTable;
  const map = new Map<number, number>();
  const decoder = new TextDecoder("shift_jis", { fatal: true });
  const register = (bytes: Uint8Array, code: number) => {
    try {
      const decoded = decoder.decode(bytes);
      const cp = decoded.codePointAt(0);
      if (cp !== undefined && decoded.length === 1 && !map.has(cp)) {
        map.set(cp, code);
      }
    } catch {
      // 未定義符号は無視
    }
  };
  for (let b = 0; b <= 0xff; b++) register(Uint8Array.of(b), b);
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if ((lead >= 0xa0 && lead <= 0xdf) || (lead >= 0xed && lead <= 0xef)) continue;
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail !== 0x7f) register(Uint8Array.of(lead, trail), (lead << 8) | trail);
    }
  }
  cachedSjisTable = map;
  return map;
}

export function findSjisUnencodable(text: string, limit = 5): UnencodableChar[] {
  const table = buildSjisEncodeTable();
  const found: UnencodableChar[] = [];
  const seen = new Set<number>();
  let line = 1;
  let column = 0;
  for (const char of text) {
    if (char === "\n") {
      line += 1;
      column = 0;
      continue;
    }
    column += 1;
    const cp = char.codePointAt(0) ?? 0;
    if (table.has(cp) || seen.has(cp)) continue;
    seen.add(cp);
    found.push({ char, codePoint: cp, line, column, suggestion: SJIS_SUGGESTIONS.get(cp) });
    if (found.length >= limit) break;
  }
  return found;
}

export function describeSjisUnencodable(items: readonly UnencodableChar[]): string {
  return items
    .map((item) => {
      const hex = `U+${item.codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
      const hint = item.suggestion ? `（「${item.suggestion}」へ置換可能）` : "";
      return `「${item.char}」(${hex}・${item.line}行${item.column}文字目)${hint}`;
    })
    .join("、");
}

function encodeSjis(text: string): Uint8Array {
  const table = buildSjisEncodeTable();
  const out = new Uint8Array(text.length * 2);
  let len = 0;
  for (const char of text) {
    const code = table.get(char.codePointAt(0) ?? -1);
    if (code === undefined) {
      throw new Error(`Shift_JIS で表現できない文字が含まれています: ${char}`);
    }
    if (code > 0xff) out[len++] = code >> 8;
    out[len++] = code & 0xff;
  }
  return out.slice(0, len);
}

function normalizeDeclaredEncoding(name: string): TextEncoding | null {
  const lower = name.trim().toLowerCase().replaceAll("_", "-");
  if (lower === "utf-8" || lower === "utf8") return "utf-8";
  if (
    lower === "shift-jis" ||
    lower === "shiftjis" ||
    lower === "sjis" ||
    lower === "ms932" ||
    lower === "cp932" ||
    lower === "windows-31j"
  ) {
    return "shift_jis";
  }
  if (lower === "utf-16le") return "utf-16le";
  if (lower === "utf-16be") return "utf-16be";
  return null;
}

function tryDecode(bytes: Uint8Array, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function hasNonAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return true;
  }
  return false;
}

function detectEol(raw: string): Eol {
  const crlf = raw.split("\r\n").length - 1;
  const lf = raw.split("\n").length - 1 - crlf;
  return crlf > 0 && crlf >= lf ? "crlf" : "lf";
}

export function decodeTextBytes(bytes: Uint8Array): DecodedText | null {
  if (bytes.byteLength >= 2) {
    const utf16: "utf-16le" | "utf-16be" | null =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? "utf-16be"
          : null;
    if (utf16) {
      if (bytes.byteLength % 2 !== 0) return null;
      const raw = tryDecode(bytes.subarray(2), utf16);
      if (raw === null || raw.includes("\0")) return null;
      const declared = XML_DECL.exec(raw)?.[2];
      const result: DecodedText = {
        text: raw.replace(/\r\n?/g, "\n"),
        encoding: utf16,
        eol: detectEol(raw),
        bom: true,
        ...(declared ? { declared } : {}),
      };
      if (declared && declared.toLowerCase() !== "utf-16") {
        const named = normalizeDeclaredEncoding(declared);
        if (named && named !== utf16) result.mismatch = true;
      }
      return result;
    }
  }

  if (bytes.includes(0)) return null;
  const bom = bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;

  let encoding: TextEncoding = "utf-8";
  let raw = tryDecode(body, "utf-8");
  if (raw === null && !bom) {
    encoding = "shift_jis";
    raw = tryDecode(body, "shift_jis");
  }
  if (raw === null) return null;

  const declared = XML_DECL.exec(raw)?.[2];
  const result: DecodedText = {
    text: raw.replace(/\r\n?/g, "\n"),
    encoding,
    eol: detectEol(raw),
    bom,
    ...(declared ? { declared } : {}),
  };

  if (encoding === "shift_jis") {
    try {
      if (!sameBytes(encodeSjis(raw), body)) result.lossy = true;
    } catch {
      result.lossy = true;
    }
  }

  if (declared) {
    const named = normalizeDeclaredEncoding(declared);
    if (named && named !== encoding) {
      if (named === "shift_jis" && encoding === "utf-8" && !bom && !hasNonAscii(raw)) {
        result.encoding = "shift_jis";
      } else {
        result.mismatch = true;
      }
    }
  }
  return result;
}

export function encodeTextBytes(text: string, format: TextFormat): Uint8Array {
  const normalized =
    format.eol === "crlf"
      ? text.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n")
      : text.replace(/\r\n?/g, "\n");

  if (format.encoding === "utf-8") {
    const body = new TextEncoder().encode(normalized);
    if (!format.bom) return body;
    const out = new Uint8Array(3 + body.byteLength);
    out.set([0xef, 0xbb, 0xbf], 0);
    out.set(body, 3);
    return out;
  }

  if (format.encoding === "shift_jis") {
    const bad = findSjisUnencodable(normalized);
    if (bad.length > 0) {
      throw new Error(`Shift_JIS に変換できない文字があります: ${describeSjisUnencodable(bad)}`);
    }
    return encodeSjis(normalized);
  }

  // UTF-16LE / UTF-16BE（常に BOM 付き）
  const out = new Uint8Array(2 + normalized.length * 2);
  const view = new DataView(out.buffer);
  const le = format.encoding === "utf-16le";
  out[0] = le ? 0xff : 0xfe;
  out[1] = le ? 0xfe : 0xff;
  for (let i = 0; i < normalized.length; i++) {
    view.setUint16(2 + i * 2, normalized.charCodeAt(i), le);
  }
  return out;
}
