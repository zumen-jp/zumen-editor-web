import assert from "node:assert/strict";
import test from "node:test";
import { decodeTextBytes, encodeTextBytes, findSjisUnencodable } from "../src/kernel/fs/text-codec";
import { parseSpreadsheetBytes } from "../src/kernel/sheet/reader";

test("UTF-8 / Shift_JIS / UTF-16LE の文字コード・BOM・改行を無損失で往復できる", () => {
  const sjisBytes = encodeTextBytes("工事名,数量\r\n橋梁上部工,12.5\r\n", {
    encoding: "shift_jis",
    eol: "crlf",
    bom: false,
  });
  const decodedSjis = decodeTextBytes(sjisBytes);
  assert.ok(decodedSjis);
  assert.equal(decodedSjis.encoding, "shift_jis");
  assert.equal(decodedSjis.eol, "crlf");
  assert.equal(decodedSjis.bom, false);
  assert.equal(decodedSjis.text, "工事名,数量\n橋梁上部工,12.5\n");

  const utf16Bytes = encodeTextBytes("特記仕様書\n第1条", {
    encoding: "utf-16le",
    eol: "lf",
    bom: true,
  });
  const decodedUtf16 = decodeTextBytes(utf16Bytes);
  assert.ok(decodedUtf16);
  assert.equal(decodedUtf16.encoding, "utf-16le");
  assert.equal(decodedUtf16.bom, true);
  assert.equal(decodedUtf16.text, "特記仕様書\n第1条");
});

test("Shift_JIS に含まれない文字と代替候補を検出する", () => {
  const bad = findSjisUnencodable("範囲: 10〜20\n温度: −5℃");
  assert.equal(bad.length, 2);
  assert.equal(bad[0]?.char, "〜");
  assert.equal(bad[0]?.suggestion, "～");
  assert.equal(bad[1]?.char, "−");
  assert.equal(bad[1]?.suggestion, "－");
});

test("Shift_JIS CSV とブラウザ ZIP 展開による .xlsx を正しく読める", async () => {
  const csvBytes = encodeTextBytes("工種,数量\r\nコンクリート,42.5\r\n", {
    encoding: "shift_jis",
    eol: "crlf",
    bom: false,
  });
  const csv = await parseSpreadsheetBytes(csvBytes, "csv");
  assert.equal(csv.format, "csv");
  assert.equal(csv.encoding, "shift_jis");
  assert.equal(csv.sheets[0]?.cells.length, 4);
  assert.equal(csv.sheets[0]?.cells[3]?.value, "42.5");
  assert.equal(csv.sheets[0]?.cells[3]?.kind, "number");

  // 最小 .xlsx ZIP を Web CompressionStream("deflate-raw") で合成して検証
  const xlsx = await buildMinimalXlsx();
  const parsed = await parseSpreadsheetBytes(xlsx, "xlsx");
  assert.equal(parsed.format, "xlsx");
  assert.equal(parsed.sheets.length, 1);
  assert.equal(parsed.sheets[0]?.name, "数量表");
  assert.equal(parsed.sheets[0]?.cells.find((c) => c.row === 0 && c.column === 0)?.value, "項目");
  assert.equal(parsed.sheets[0]?.cells.find((c) => c.row === 1 && c.column === 1)?.value, "150");
});

async function deflateRaw(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const w = cs.writable.getWriter();
  const wp = w.write(input as unknown as BufferSource).then(() => w.close());
  const r = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await r.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await wp;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function buildMinimalXlsx(): Promise<Uint8Array> {
  const files: Record<string, string> = {
    "xl/workbook.xml":
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数量表" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml":
      '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>項目</t></si><si><t>鉄筋</t></si></sst>',
    "xl/worksheets/sheet1.xml":
      '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>150</v></c></row></sheetData></worksheet>',
  };

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = new TextEncoder().encode(name);
    const raw = new TextEncoder().encode(content);
    const comp = await deflateRaw(raw);

    const local = new Uint8Array(30 + nameBytes.byteLength + comp.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, comp.byteLength, true);
    lv.setUint32(22, raw.byteLength, true);
    lv.setUint16(26, nameBytes.byteLength, true);
    local.set(nameBytes, 30);
    local.set(comp, 30 + nameBytes.byteLength);
    locals.push(local);

    const cen = new Uint8Array(46 + nameBytes.byteLength);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, comp.byteLength, true);
    cv.setUint32(24, raw.byteLength, true);
    cv.setUint16(28, nameBytes.byteLength, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    centrals.push(cen);

    offset += local.byteLength;
  }

  const cdSize = centrals.reduce((s, b) => s + b.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + cdSize + eocd.byteLength;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}
