// Pure Web Streams API（CompressionStream / DecompressionStream）による PNG 再圧縮。
// zumen の `render` が返す非圧縮 PNG（約 3 MB）を画素を変えずに数 KB〜数十 KB へ圧縮する。

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_INFLATED_BYTES = 16_777_216 * 4 + 65_536;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i++) {
    c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3),
  ]);
  const body = concatBytes([typeBytes, data]);
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength, false);
  out.set(body, 4);
  view.setUint32(4 + body.byteLength, crc32(body), false);
  return out;
}

async function transformZlib(
  stream: CompressionStream | DecompressionStream,
  input: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const writing = writer.write(input as unknown as BufferSource).then(() => writer.close());
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("PNG 展開上限を超えました。");
      }
      chunks.push(value);
    }
    await writing;
  } finally {
    reader.releaseLock();
  }
  return concatBytes(chunks);
}

export async function recompressPng(png: Uint8Array): Promise<Uint8Array> {
  try {
    if (png.byteLength < PNG_SIG.byteLength) return png;
    for (let i = 0; i < PNG_SIG.byteLength; i++) {
      if (png[i] !== PNG_SIG[i]) return png;
    }
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const before: Uint8Array[] = [];
    const after: Uint8Array[] = [];
    const idatParts: Uint8Array[] = [];
    let pos = PNG_SIG.byteLength;

    while (pos + 12 <= png.byteLength) {
      const length = view.getUint32(pos, false);
      const end = pos + 12 + length;
      if (end > png.byteLength) return png;
      const type = String.fromCharCode(
        png[pos + 4] ?? 0,
        png[pos + 5] ?? 0,
        png[pos + 6] ?? 0,
        png[pos + 7] ?? 0,
      );
      if (type === "IDAT") {
        idatParts.push(png.subarray(pos + 8, pos + 8 + length));
      } else {
        (idatParts.length === 0 ? before : after).push(png.subarray(pos, end));
      }
      pos = end;
    }

    if (pos !== png.byteLength || idatParts.length === 0) return png;
    const rawPixels = await transformZlib(
      new DecompressionStream("deflate"),
      concatBytes(idatParts),
      MAX_INFLATED_BYTES,
    );
    const packed = await transformZlib(
      new CompressionStream("deflate"),
      rawPixels,
      MAX_INFLATED_BYTES,
    );
    const out = concatBytes([PNG_SIG, ...before, buildChunk("IDAT", packed), ...after]);
    return out.byteLength < png.byteLength ? out : png;
  } catch {
    return png;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength));
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}
