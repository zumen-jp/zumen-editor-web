# zumen-editor-web

Google Chrome ブラウザ上でほぼ完結して動く、オープンソースの CAD・図面 AI エディターです（`MIT OR Apache-2.0`）。

- **ブラウザ完結の図面・ファイル処理**: [`@zumen-jp/zumen`](https://github.com/zumen-jp/zumen)（WebAssembly `+simd128`）を専用 Web Worker で動かし、[`@zumen-jp/view2d`](https://github.com/zumen-jp/zumen)（WebGPU）で DXF・DWG・JWW・SXF を 60 fps で描画します。ローカルフォルダーは Chrome の File System Access API、一時領域と 20 世代バックアップは OPFS、会話履歴は IndexedDB で扱います。
- **Sign in with ChatGPT（SIWC）＋ OpenAI Agents SDK**: [Sign in with ChatGPT](https://developers.openai.com/siwc?translationFallback=ja-JP) でログインし、対象プランの利用枠で [`@openai/agents`](https://github.com/openai/openai-agents-js) を Chrome 内で直接動かします（開発・審査待ち期間向けにメモリ内限定の BYOK API キーモードも切替可能）。
- **極薄ステートレス BFF（Cloudflare Workers）**: サーバー側にはデータベースも図面保存も持ちません。静的配信、SIWC OAuth 2.0/PKCE（暗号化 HttpOnly Cookie）、および OpenAI Responses API（`store: false`, `stream: true` 強制）の透過ストリーミング中継だけを行います。
- **安全な編集モデル**: エージェントは図面を直接書き換えられず、`drawing_propose` で写しに適用検証した変更案を提案します。適用（「当てる」）と保存・書き出し・削除等の境界操作（`action_propose`）は必ず利用者が実行します。

## 動作要件

- **ブラウザ**: Google Chrome 最新版（WebGPU・File System Access API・OPFS・WebAssembly SIMD 対応）
- **開発環境**: Node.js 24 以降

## セットアップ（ローカル開発）

```bash
npm install
cp .env.example .env.local
# .env.local の SESSION_SECRET / OPENAI_SIWC_CLIENT_ID 等を設定
npm run dev
```

`http://127.0.0.1:24120` を Chrome で開きます。AI を使わない図面閲覧・編集・基準照合・保存はログイン不要ですぐ動作します。

## Cloudflare Workers へのデプロイ（例: `editor.zumen.dev`）

```bash
# 本番シークレットを設定（32 文字以上のランダム文字列・SIWC client_id 等）
npx wrangler secret put SESSION_SECRET
npx wrangler secret put OPENAI_SIWC_CLIENT_ID
# Confidential Client の場合のみ
npx wrangler secret put OPENAI_SIWC_CLIENT_SECRET

# ビルド＆デプロイ
npm run cf:deploy
```

> **SIWC の配布トラックについて**: オープンソースのローカル実行では `OPENAI_SIWC_CLIENT_ID=dynamic_agent_client` を使えます。インターネット上に公開するリモートホスト型 Web アプリ（`https://editor.zumen.dev`）で ChatGPT Plan Usage を提供する場合は、OpenAI へのパートナー申請・登録による固定 `client_id`（`oaiapp_...`）の取得が必要です。

## 検査

```bash
npm run check     # Biome lint・TypeScript 型検査・単体テスト（node --test）
npm run build     # Next.js 本番ビルド
npm run cf:build  # Cloudflare Workers（@opennextjs/cloudflare）ビルド検証
```

## ライセンス

- コード: `MIT OR Apache-2.0`（[LICENSE-MIT](LICENSE-MIT) / [LICENSE-APACHE](LICENSE-APACHE)）
- 同梱の照合プロファイル（`public/assets/zumen/profiles/`）: `CC BY 4.0`（出典: zumen の貢献者、[profiles-LICENSE.md](public/assets/zumen/profiles-LICENSE.md)）
