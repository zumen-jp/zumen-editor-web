import { HOST_COOKIE_NAME, loadSiwcConfig, TX_COOKIE_NAME } from "@/server/siwc/config";
import { formatSetCookie, parseCookieHeader, sealJson } from "@/server/siwc/crypto";
import { beginSiwcAuthorization } from "@/server/siwc/oauth";

const TX_PURPOSE = "siwc-tx";
const TX_TTL_SECONDS = 600;
const HOST_TTL_SECONDS = 365 * 24 * 60 * 60;

export async function GET(request: Request): Promise<Response> {
  const config = loadSiwcConfig(request.url);
  if (!config.isConfigured) {
    const missing = !config.clientId ? "OPENAI_SIWC_CLIENT_ID" : "SESSION_SECRET（32 文字以上）";
    return Response.json(
      {
        error: {
          code: "siwc_not_configured",
          message: `${missing} が設定されていません。開発中は BYOK（API キー）モードも利用できます。`,
        },
      },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const popup = url.searchParams.get("popup") !== "0";
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const existingHostId = cookies.get(HOST_COOKIE_NAME);
  const hostId = config.hostId || existingHostId || `urn:uuid:${crypto.randomUUID()}`;

  try {
    const { authorizeUrl, tx } = await beginSiwcAuthorization({
      config,
      hostId,
      popup,
    });
    const secure = config.isProduction || config.appOrigin.startsWith("https://");
    const txCookie = formatSetCookie(
      TX_COOKIE_NAME,
      await sealJson(tx, config.sessionSecret, TX_PURPOSE),
      { maxAgeSeconds: TX_TTL_SECONDS, secure, httpOnly: true, sameSite: "Lax" },
    );

    const headers = new Headers({
      Location: authorizeUrl,
      "Cache-Control": "no-store",
    });
    headers.append("Set-Cookie", txCookie);
    if (!existingHostId && !config.hostId) {
      headers.append(
        "Set-Cookie",
        formatSetCookie(HOST_COOKIE_NAME, hostId, {
          maxAgeSeconds: HOST_TTL_SECONDS,
          secure,
          httpOnly: true,
          sameSite: "Lax",
        }),
      );
    }

    return new Response(null, { status: 302, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "認可の開始に失敗しました。";
    return Response.json({ error: { code: "auth_start_failed", message } }, { status: 502 });
  }
}
