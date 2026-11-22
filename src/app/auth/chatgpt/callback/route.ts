import { loadSiwcConfig, TX_COOKIE_NAME } from "@/server/siwc/config";
import { formatSetCookie, parseCookieHeader, unsealJson } from "@/server/siwc/crypto";
import { completeSiwcCallback, type SiwcTxState } from "@/server/siwc/oauth";
import { buildSessionCookie } from "@/server/siwc/proxy";

const TX_PURPOSE = "siwc-tx";
const TX_MAX_AGE_MS = 10 * 60_000;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function popupResultHtml(result: { ok: boolean; error?: string }, popup: boolean): string {
  const payload = JSON.stringify(result).replaceAll("<", "\\u003c");
  const title = result.ok ? "ログインしました" : "ログインに失敗しました";
  const body = result.ok
    ? "元のウィンドウへ戻ります。自動で閉じない場合はこのタブを閉じてください。"
    : escapeHtml(result.error ?? "認証を完了できませんでした。");

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>${title} - zumen editor web</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #1f2937; background: #f8fafc; }
    .card { max-width: 420px; margin: 3rem auto; padding: 1.5rem; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; }
    h1 { font-size: 1.1rem; margin: 0 0 0.75rem; }
    p { font-size: 0.9rem; line-height: 1.6; margin: 0; color: #475569; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
  <script>
    (function () {
      var payload = ${payload};
      try {
        var ch = new BroadcastChannel("zumen-siwc-auth");
        ch.postMessage(payload);
        ch.close();
      } catch (e) {}
      if (${popup ? "true" : "false"}) {
        setTimeout(function () { window.close(); }, 250);
      } else if (payload.ok) {
        location.replace("/");
      }
    })();
  </script>
</body>
</html>`;
}

export async function GET(request: Request): Promise<Response> {
  const config = loadSiwcConfig(request.url);
  const secure = config.isProduction || config.appOrigin.startsWith("https://");
  const clearTx = formatSetCookie(TX_COOKIE_NAME, "", {
    maxAgeSeconds: 0,
    secure,
    httpOnly: true,
    sameSite: "Lax",
  });

  const url = new URL(request.url);
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const tx = config.hasValidSessionSecret
    ? await unsealJson<SiwcTxState>(cookies.get(TX_COOKIE_NAME), config.sessionSecret, TX_PURPOSE)
    : null;
  const popup = tx?.popup ?? true;

  const fail = (message: string, status = 400) => {
    const headers = new Headers({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    headers.append("Set-Cookie", clearTx);
    return new Response(popupResultHtml({ ok: false, error: message }, popup), { status, headers });
  };

  if (!config.isConfigured) {
    return fail("この環境では Sign in with ChatGPT の設定が完了していません。", 503);
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const desc = url.searchParams.get("error_description") || oauthError;
    return fail(`ChatGPT ログインが中断されました（${desc}）。`, 400);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!tx || !code || !state) {
    return fail("認証セッションが見つかりません。もう一度ログインをやり直してください。", 400);
  }
  if (tx.state !== state || Date.now() - tx.createdAt > TX_MAX_AGE_MS) {
    return fail("認証状態の検証に失敗しました（有効期限切れまたは不一致）。", 400);
  }

  try {
    const session = await completeSiwcCallback({
      config,
      tx,
      code,
      returnedClientId: url.searchParams.get("client_id"),
    });
    const sessionCookie = await buildSessionCookie(session, config);
    const headers = new Headers({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    headers.append("Set-Cookie", clearTx);
    headers.append("Set-Cookie", sessionCookie);
    return new Response(popupResultHtml({ ok: true }, popup), { status: 200, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "認証を完了できませんでした。";
    return fail(message, 502);
  }
}
