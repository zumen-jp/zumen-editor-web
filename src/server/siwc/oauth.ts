import type { SiwcConfig } from "./config";
import { createPkcePair, randomToken } from "./crypto";
import { fetchOidcDiscovery, type VerifiedIdentity, verifyIdToken } from "./jwks";

export type SiwcTxState = {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  popup: boolean;
  createdAt: number;
};

export type SiwcSessionData = {
  user: VerifiedIdentity;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
};

export type PublicAuthSession = {
  signedIn: boolean;
  siwcConfigured: boolean;
  user: VerifiedIdentity | null;
  expiresAt: number | null;
  hasPlanUsageScope: boolean;
};

export function toPublicAuthSession(
  session: SiwcSessionData | null,
  siwcConfigured: boolean,
): PublicAuthSession {
  if (!session) {
    return {
      signedIn: false,
      siwcConfigured,
      user: null,
      expiresAt: null,
      hasPlanUsageScope: false,
    };
  }
  const scopeList = (session.scope ?? "").split(/\s+/);
  return {
    signedIn: true,
    siwcConfigured,
    user: session.user,
    expiresAt: session.expiresAt,
    hasPlanUsageScope:
      scopeList.includes("chatgpt.tokens.use.direct") || scopeList.includes("resource.invoke"),
  };
}

export async function beginSiwcAuthorization(params: {
  config: SiwcConfig;
  hostId: string;
  popup: boolean;
  fetcher?: typeof fetch;
}): Promise<{ authorizeUrl: string; tx: SiwcTxState }> {
  const { config, hostId, popup, fetcher } = params;
  if (!config.isConfigured) {
    throw new Error("OPENAI_SIWC_CLIENT_ID が設定されていません。");
  }
  const discovery = await fetchOidcDiscovery(config.issuer, fetcher);
  const pkce = await createPkcePair();
  const state = randomToken(24);
  const nonce = randomToken(24);
  const redirectUri = `${config.appOrigin}/auth/chatgpt/callback`;

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");

  if (
    config.scopes.includes("chatgpt.tokens.use.direct") ||
    config.scopes.includes("resource.invoke")
  ) {
    url.searchParams.set("resource", config.resource);
  }
  if (config.clientId === "dynamic_agent_client") {
    url.searchParams.set("ext_agent_host_id", hostId);
    url.searchParams.set("agent_name_hint", config.agentName);
  }

  return {
    authorizeUrl: url.toString(),
    tx: {
      state,
      nonce,
      codeVerifier: pkce.verifier,
      redirectUri,
      clientId: config.clientId,
      popup,
      createdAt: Date.now(),
    },
  };
}

type TokenEndpointResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  client_id?: string;
  error?: string;
  error_description?: string;
};

export async function completeSiwcCallback(params: {
  config: SiwcConfig;
  tx: SiwcTxState;
  code: string;
  returnedClientId?: string | null;
  fetcher?: typeof fetch;
}): Promise<SiwcSessionData> {
  const { config, tx, code, returnedClientId, fetcher = fetch } = params;
  const discovery = await fetchOidcDiscovery(config.issuer, fetcher);
  const effectiveClientId = returnedClientId?.trim() || tx.clientId;

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: tx.redirectUri,
    client_id: effectiveClientId,
    code_verifier: tx.codeVerifier,
  });
  if (config.clientSecret) {
    form.set("client_secret", config.clientSecret);
  }

  const res = await fetcher(discovery.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });
  const body = (await res.json().catch(() => ({}))) as TokenEndpointResponse;
  if (!res.ok || !body.access_token) {
    const detail = body.error_description || body.error || `HTTP ${res.status}`;
    throw new Error(`トークン交換に失敗しました（${detail}）。`);
  }

  const finalClientId = body.client_id?.trim() || effectiveClientId;
  const expectedClientIds = Array.from(new Set([finalClientId, tx.clientId]));

  let user: VerifiedIdentity = { sub: "unknown" };
  if (body.id_token) {
    user = await verifyIdToken({
      idToken: body.id_token,
      expectedIssuer: discovery.issuer,
      expectedClientIds,
      expectedNonce: tx.nonce,
      jwksUri: discovery.jwks_uri,
      fetcher,
    });
  }

  const expiresInMs = Math.max(60, Number(body.expires_in) || 3600) * 1000;
  return {
    user,
    clientId: finalClientId,
    accessToken: body.access_token,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    expiresAt: Date.now() + expiresInMs,
    scope: body.scope ?? config.scopes,
  };
}

export async function refreshSiwcSession(params: {
  config: SiwcConfig;
  session: SiwcSessionData;
  fetcher?: typeof fetch;
}): Promise<SiwcSessionData> {
  const { config, session, fetcher = fetch } = params;
  if (!session.refreshToken) {
    throw new Error("リフレッシュトークンがないため再ログインが必要です。");
  }
  const discovery = await fetchOidcDiscovery(config.issuer, fetcher);
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: session.clientId,
  });
  if (config.clientSecret) {
    form.set("client_secret", config.clientSecret);
  }

  const res = await fetcher(discovery.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });
  const body = (await res.json().catch(() => ({}))) as TokenEndpointResponse;
  if (!res.ok || !body.access_token) {
    const detail = body.error_description || body.error || `HTTP ${res.status}`;
    throw new Error(`セッションの更新に失敗しました（${detail}）。`);
  }

  const expiresInMs = Math.max(60, Number(body.expires_in) || 3600) * 1000;
  return {
    ...session,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? session.refreshToken,
    expiresAt: Date.now() + expiresInMs,
    scope: body.scope ?? session.scope,
  };
}
