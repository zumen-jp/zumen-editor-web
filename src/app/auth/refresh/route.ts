import { loadSiwcConfig } from "@/server/siwc/config";
import { verifySameOriginRequest } from "@/server/siwc/csrf";
import { refreshSiwcSession, toPublicAuthSession } from "@/server/siwc/oauth";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  readSessionFromRequest,
} from "@/server/siwc/proxy";

export async function POST(request: Request): Promise<Response> {
  const config = loadSiwcConfig(request.url);
  const csrfError = verifySameOriginRequest(request, config);
  if (csrfError) {
    return Response.json({ error: { code: "forbidden", message: csrfError } }, { status: 403 });
  }
  const current = await readSessionFromRequest(request, config);
  if (!current) {
    return Response.json(
      { error: { code: "unauthenticated", message: "ログインしていません。" } },
      { status: 401 },
    );
  }
  try {
    const refreshed = await refreshSiwcSession({ config, session: current });
    const cookie = await buildSessionCookie(refreshed, config);
    return Response.json(toPublicAuthSession(refreshed, config.isConfigured), {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": cookie,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "セッションを更新できませんでした。";
    return Response.json(
      { error: { code: "refresh_failed", message } },
      {
        status: 401,
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": buildClearSessionCookie(config),
        },
      },
    );
  }
}
