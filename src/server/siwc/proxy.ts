import { loadSiwcConfig, SESSION_COOKIE_NAME, type SiwcConfig } from "./config";
import { formatSetCookie, parseCookieHeader, sealJson, unsealJson } from "./crypto";
import { verifySameOriginRequest } from "./csrf";
import { refreshSiwcSession, type SiwcSessionData } from "./oauth";

const SESSION_PURPOSE = "siwc-session";
const REFRESH_MARGIN_MS = 120_000;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_RESPONSES_BODY_BYTES = 20 * 1024 * 1024;

/** SIWC プレビューの Responses API 経路で非対応のサーバー組み込みツール種別。 */
const DISALLOWED_TOOL_TYPES = new Set([
  "code_interpreter",
  "file_search",
  "computer_use",
  "computer_use_preview",
  "image_generation",
  "mcp",
  "tool_search",
]);

export async function readSessionFromRequest(
  request: Request,
  config: SiwcConfig,
): Promise<SiwcSessionData | null> {
  if (!config.hasValidSessionSecret || !config.sessionSecret) {
    return null;
  }
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  return unsealJson<SiwcSessionData>(
    cookies.get(SESSION_COOKIE_NAME),
    config.sessionSecret,
    SESSION_PURPOSE,
  );
}

export async function buildSessionCookie(
  session: SiwcSessionData,
  config: SiwcConfig,
): Promise<string> {
  if (!config.hasValidSessionSecret || !config.sessionSecret) {
    throw new Error(
      "SESSION_SECRET が未設定または短すぎます。32 文字以上のランダム文字列を環境変数に設定してください。",
    );
  }
  const sealed = await sealJson(session, config.sessionSecret, SESSION_PURPOSE);
  return formatSetCookie(SESSION_COOKIE_NAME, sealed, {
    maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
    secure: config.isProduction || config.appOrigin.startsWith("https://"),
    httpOnly: true,
    sameSite: "Lax",
  });
}

export function buildClearSessionCookie(config: SiwcConfig): string {
  return formatSetCookie(SESSION_COOKIE_NAME, "", {
    maxAgeSeconds: 0,
    secure: config.isProduction || config.appOrigin.startsWith("https://"),
    httpOnly: true,
    sameSite: "Lax",
  });
}

async function resolveActiveSession(
  request: Request,
  config: SiwcConfig,
): Promise<{ session: SiwcSessionData; rotatedCookie: string | null } | Response> {
  const csrfError = verifySameOriginRequest(request, config);
  if (csrfError) {
    return Response.json({ error: { code: "forbidden", message: csrfError } }, { status: 403 });
  }
  const current = await readSessionFromRequest(request, config);
  if (!current) {
    return Response.json(
      { error: { code: "unauthenticated", message: "ChatGPT でログインしてください。" } },
      { status: 401 },
    );
  }

  if (Date.now() < current.expiresAt - REFRESH_MARGIN_MS) {
    return { session: current, rotatedCookie: null };
  }

  if (!current.refreshToken) {
    return Response.json(
      {
        error: {
          code: "session_expired",
          message: "セッションの有効期限が切れました。再度ログインしてください。",
        },
      },
      {
        status: 401,
        headers: { "Set-Cookie": buildClearSessionCookie(config) },
      },
    );
  }

  try {
    const refreshed = await refreshSiwcSession({ config, session: current });
    const rotatedCookie = await buildSessionCookie(refreshed, config);
    return { session: refreshed, rotatedCookie };
  } catch {
    return Response.json(
      {
        error: {
          code: "refresh_failed",
          message: "セッションを更新できませんでした。再度ログインしてください。",
        },
      },
      {
        status: 401,
        headers: { "Set-Cookie": buildClearSessionCookie(config) },
      },
    );
  }
}

export async function proxyModelsRequest(request: Request): Promise<Response> {
  const config = loadSiwcConfig(request.url);
  const resolved = await resolveActiveSession(request, config);
  if (resolved instanceof Response) return resolved;

  const upstream = await fetch(`${config.apiBaseUrl}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${resolved.session.accessToken}`,
      Accept: "application/json",
    },
    signal: request.signal,
  });

  const headers = new Headers({
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    "Cache-Control": "no-store",
  });
  if (resolved.rotatedCookie) {
    headers.set("Set-Cookie", resolved.rotatedCookie);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

/**
 * OpenAI Responses API への透過ストリーミング中継。
 * - SIWC 必須制約（`store: false`, `stream: true`）を強制する。
 * - プロンプトやツール結果をログにも DB にも保存しない。
 */
export async function proxyResponsesRequest(request: Request): Promise<Response> {
  const config = loadSiwcConfig(request.url);
  const resolved = await resolveActiveSession(request, config);
  if (resolved instanceof Response) return resolved;

  const rawText = await request.text();
  if (rawText.length > MAX_RESPONSES_BODY_BYTES) {
    return Response.json(
      { error: { code: "payload_too_large", message: "送信サイズが上限（20 MB）を超えました。" } },
      { status: 413 },
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: { code: "bad_request", message: "JSON の形式が正しくありません。" } },
      { status: 400 },
    );
  }

  // SIWC Plan Usage ルートで非対応のサーバー組み込みツールを入口で拒否する。
  if (Array.isArray(body.tools)) {
    for (const item of body.tools) {
      if (
        item &&
        typeof item === "object" &&
        "type" in item &&
        typeof (item as { type: unknown }).type === "string" &&
        DISALLOWED_TOOL_TYPES.has((item as { type: string }).type)
      ) {
        return Response.json(
          {
            error: {
              code: "unsupported_tool",
              message: `SIWC 経路ではツール種別「${(item as { type: string }).type}」を使用できません。`,
            },
          },
          { status: 400 },
        );
      }
    }
  }

  // SIWC 必須パラメーターを強制。
  const sanitized: Record<string, unknown> = {
    ...body,
    store: false,
    stream: true,
  };
  delete sanitized.previous_response_id;
  delete sanitized.programmatic_tool_calling;

  const upstream = await fetch(`${config.apiBaseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolved.session.accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    },
    body: JSON.stringify(sanitized),
    signal: request.signal,
  });

  const contentType = upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8";
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  if (resolved.rotatedCookie) {
    headers.set("Set-Cookie", resolved.rotatedCookie);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}
