// node_modules/@zumen-jp/zumen から公開 WASM バイナリを public/assets/wasm/ へ同期する。
// Git に巨大なバイナリを入れず、npm ci 後の静的配信と Cloudflare Workers Static Assets に対応させる。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "node_modules", "@zumen-jp", "zumen");
const OUT_DIR = path.join(ROOT, "public", "assets", "wasm");

const WASM_FILES = [
  "zumen_abi1.wasm",
  "zumen_abi1_drawing.wasm",
  "zumen_abi1_bim.wasm",
  "zumen_abi1_civil.wasm",
  "zumen_abi1_pointcloud.wasm",
];

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(
      "sync:assets: @zumen-jp/zumen が見つかりません。先に npm install を実行してください。",
    );
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let copied = 0;
  for (const file of WASM_FILES) {
    const from = path.join(SRC_DIR, file);
    if (!fs.existsSync(from)) continue;
    const to = path.join(OUT_DIR, file);
    const srcStat = fs.statSync(from);
    const dstStat = fs.existsSync(to) ? fs.statSync(to) : null;
    if (!dstStat || dstStat.size !== srcStat.size || dstStat.mtimeMs < srcStat.mtimeMs) {
      fs.copyFileSync(from, to);
    }
    copied += 1;
  }
  if (copied === 0) {
    console.error("sync:assets: コピー対象の WASM が見つかりません。");
    process.exit(1);
  }
}

main();
