// OpenID Connect Discovery と JWKS による ID Token 署名・クレーム検証（Pure Web Crypto）。

import { base64UrlDecode } from "./crypto";

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
};

export type VerifiedIdentity = {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
};

type Cached<T> = { value: T; expiresAt: number };

const DISCOVERY_TTL_MS = 10 * 60_000;
const JWKS_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_SECONDS = 60;

const discoveryCache = new Map<string, Cached<OidcDiscovery>>();
const jwksCache = new Map<string, Cached<JsonWebKey[]>>();

export async function fetchOidcDiscovery(
  issuer: string,
  fetcher: typeof fetch = fetch,
): Promise<OidcDiscovery> {
  const normalized = issuer.replace(/\/+$/, "");
  const cached = discoveryCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const res = await fetcher(`${normalized}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`OIDC Discovery を取得できませんでした（HTTP ${res.status}）。`);
  }
  const doc = (await res.json()) as Partial<OidcDiscovery>;
  if (
    typeof doc.issuer !== "string" ||
    typeof doc.authorization_endpoint !== "string" ||
    typeof doc.token_endpoint !== "string" ||
    typeof doc.jwks_uri !== "string"
  ) {
    throw new Error("OIDC Discovery の必須フィールドが不足しています。");
  }
  const value: OidcDiscovery = {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks_uri: doc.jwks_uri,
    ...(typeof doc.revocation_endpoint === "string"
      ? { revocation_endpoint: doc.revocation_endpoint }
      : {}),
  };
  discoveryCache.set(normalized, { value, expiresAt: Date.now() + DISCOVERY_TTL_MS });
  return value;
}

async function fetchJwks(
  jwksUri: string,
  forceRefresh: boolean,
  fetcher: typeof fetch = fetch,
): Promise<JsonWebKey[]> {
  if (!forceRefresh) {
    const cached = jwksCache.get(jwksUri);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
  }
  const res = await fetcher(jwksUri, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`JWKS を取得できませんでした（HTTP ${res.status}）。`);
  }
  const body = (await res.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) {
    throw new Error("JWKS の形式が不正です。");
  }
  const keys = body.keys as JsonWebKey[];
  jwksCache.set(jwksUri, { value: keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return keys;
}

type JwtHeader = { alg?: string; kid?: string; typ?: string };
type JwtPayload = {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  nonce?: string;
  name?: string;
  email?: string;
  picture?: string;
};

const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

async function verifySignatureWithKey(
  alg: string,
  jwk: JsonWebKey,
  signingInput: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (alg === "RS256") {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      signature as BufferSource,
      signingInput as BufferSource,
    );
  }
  if (alg === "ES256") {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature as BufferSource,
      signingInput as BufferSource,
    );
  }
  return false;
}

/**
 * OIDC ID Token を JWKS で検証し、確認済みの利用者識別情報を返す。
 */
export async function verifyIdToken(params: {
  idToken: string;
  expectedIssuer: string;
  expectedClientIds: readonly string[];
  expectedNonce: string;
  jwksUri: string;
  nowSeconds?: number;
  fetcher?: typeof fetch;
}): Promise<VerifiedIdentity> {
  const parts = params.idToken.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("ID トークンの形式が不正です。");
  }
  const header = JSON.parse(DECODER.decode(base64UrlDecode(parts[0]))) as JwtHeader;
  const payload = JSON.parse(DECODER.decode(base64UrlDecode(parts[1]))) as JwtPayload;
  const signature = base64UrlDecode(parts[2]);
  const signingInput = ENCODER.encode(`${parts[0]}.${parts[1]}`);

  const alg = header.alg ?? "";
  if (alg !== "RS256" && alg !== "ES256") {
    throw new Error(`未対応の ID トークン署名方式です: ${alg}`);
  }

  let keys = await fetchJwks(params.jwksUri, false, params.fetcher);
  let matched = findCandidateKeys(keys, header.kid);
  if (matched.length === 0) {
    keys = await fetchJwks(params.jwksUri, true, params.fetcher);
    matched = findCandidateKeys(keys, header.kid);
  }
  if (matched.length === 0) {
    throw new Error("ID トークンに対応する公開鍵が JWKS に見つかりません。");
  }

  let verified = false;
  for (const jwk of matched) {
    try {
      if (await verifySignatureWithKey(alg, jwk, signingInput, signature)) {
        verified = true;
        break;
      }
    } catch {
      // 次の候補鍵を試す
    }
  }
  if (!verified) {
    throw new Error("ID トークンの署名検証に失敗しました。");
  }

  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const normIss = (value: string) => value.replace(/\/+$/, "");
  if (!payload.iss || normIss(payload.iss) !== normIss(params.expectedIssuer)) {
    throw new Error("ID トークンの発行者（iss）が一致しません。");
  }
  const audiences = Array.isArray(payload.aud)
    ? payload.aud
    : typeof payload.aud === "string"
      ? [payload.aud]
      : [];
  const validAud = audiences.some((aud) => params.expectedClientIds.includes(aud));
  if (!validAud) {
    throw new Error("ID トークンの対象クライアント（aud）が一致しません。");
  }
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS < now) {
    throw new Error("ID トークンの有効期限が切れています。");
  }
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_SECONDS > now) {
    throw new Error("ID トークンはまだ有効ではありません。");
  }
  if (payload.nonce !== params.expectedNonce) {
    throw new Error("ID トークンの nonce が一致しません。");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("ID トークンに利用者識別子（sub）がありません。");
  }

  return {
    sub: payload.sub,
    ...(typeof payload.name === "string" ? { name: payload.name } : {}),
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
    ...(typeof payload.picture === "string" ? { picture: payload.picture } : {}),
  };
}

function findCandidateKeys(keys: readonly JsonWebKey[], kid: string | undefined): JsonWebKey[] {
  if (!kid) return [...keys];
  return keys.filter((k) => (k as JsonWebKey & { kid?: string }).kid === kid);
}
