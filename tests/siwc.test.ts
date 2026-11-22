import assert from "node:assert/strict";
import test from "node:test";
import { loadSiwcConfig, type SiwcConfig } from "../src/server/siwc/config";
import { base64UrlEncode, createPkcePair, sealJson, unsealJson } from "../src/server/siwc/crypto";
import { verifySameOriginRequest } from "../src/server/siwc/csrf";
import { verifyIdToken } from "../src/server/siwc/jwks";
import { beginSiwcAuthorization } from "../src/server/siwc/oauth";
import { buildSessionCookie, readSessionFromRequest } from "../src/server/siwc/proxy";

const TEST_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

function makeConfig(overrides?: Partial<SiwcConfig>): SiwcConfig {
  return {
    appOrigin: "https://editor.zumen.dev",
    issuer: "https://auth.openai.com",
    apiBaseUrl: "https://api.openai.com/v1",
    clientId: "oaiapp_test123",
    clientSecret: "",
    hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
    agentName: "zumen-editor-web",
    scopes: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource: "https://api.openai.com/v1",
    sessionSecret: TEST_SECRET,
    hasValidSessionSecret: true,
    isProduction: true,
    isConfigured: true,
    ...overrides,
  };
}

test("AES-256-GCM Cookie 暗号化の往復・改ざん拒否・用途分離", async () => {
  const payload = { sub: "user_1", token: "secret_abc", exp: 12345 };
  const sealed = await sealJson(payload, TEST_SECRET, "siwc-session");
  assert.ok(sealed.startsWith("v1."));

  const opened = await unsealJson<typeof payload>(sealed, TEST_SECRET, "siwc-session");
  assert.deepEqual(opened, payload);

  // 別用途 AAD では復号不可
  const wrongPurpose = await unsealJson(sealed, TEST_SECRET, "siwc-tx");
  assert.equal(wrongPurpose, null);

  // 鍵が違うと復号不可
  const wrongSecret = await unsealJson(sealed, `${TEST_SECRET}x`, "siwc-session");
  assert.equal(wrongSecret, null);

  // 1 文字改ざんで復号不可
  const tampered = `${sealed.slice(0, -1)}${sealed.endsWith("A") ? "B" : "A"}`;
  assert.equal(await unsealJson(tampered, TEST_SECRET, "siwc-session"), null);
});

test("PKCE S256 チャレンジが SHA-256(verifier) と一致する", async () => {
  const { verifier, challenge } = await createPkcePair();
  assert.ok(verifier.length >= 43);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  assert.equal(challenge, base64UrlEncode(new Uint8Array(digest)));
});

test("Web Crypto JWKS で RS256 ID Token を署名・クレーム検証できる", async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & {
    kid?: string;
  };
  publicJwk.kid = "kid-test-1";

  const now = Math.floor(Date.now() / 1000);
  const signJwt = async (claims: Record<string, unknown>) => {
    const headerB64 = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "kid-test-1" })),
    );
    const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
    const sig = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      keyPair.privateKey,
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    return `${headerB64}.${payloadB64}.${base64UrlEncode(new Uint8Array(sig))}`;
  };

  const mockFetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const validToken = await signJwt({
    iss: "https://auth.openai.com",
    sub: "acct_42",
    aud: "oaiapp_test123",
    exp: now + 3600,
    nonce: "nonce-xyz",
    name: "テスト設計者",
  });

  const identity = await verifyIdToken({
    idToken: validToken,
    expectedIssuer: "https://auth.openai.com",
    expectedClientIds: ["oaiapp_test123"],
    expectedNonce: "nonce-xyz",
    jwksUri: "https://auth.openai.com/.well-known/jwks.json",
    nowSeconds: now,
    fetcher: mockFetcher,
  });
  assert.equal(identity.sub, "acct_42");
  assert.equal(identity.name, "テスト設計者");

  // nonce 不一致を拒否
  await assert.rejects(() =>
    verifyIdToken({
      idToken: validToken,
      expectedIssuer: "https://auth.openai.com",
      expectedClientIds: ["oaiapp_test123"],
      expectedNonce: "wrong-nonce",
      jwksUri: "https://auth.openai.com/.well-known/jwks.json",
      nowSeconds: now,
      fetcher: mockFetcher,
    }),
  );

  // 期限切れを拒否
  const expiredToken = await signJwt({
    iss: "https://auth.openai.com",
    sub: "acct_42",
    aud: "oaiapp_test123",
    exp: now - 300,
    nonce: "nonce-xyz",
  });
  await assert.rejects(() =>
    verifyIdToken({
      idToken: expiredToken,
      expectedIssuer: "https://auth.openai.com",
      expectedClientIds: ["oaiapp_test123"],
      expectedNonce: "nonce-xyz",
      jwksUri: "https://auth.openai.com/.well-known/jwks.json",
      nowSeconds: now,
      fetcher: mockFetcher,
    }),
  );
});

test("SIWC 認可 URL に PKCE・resource・動的クライアント引数が正しく設定される", async () => {
  const mockFetcher: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        issuer: "https://auth.openai.com",
        authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
        token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
        jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
      }),
      { status: 200 },
    );

  const dyn = await beginSiwcAuthorization({
    config: makeConfig({ clientId: "dynamic_agent_client" }),
    hostId: "urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    popup: true,
    fetcher: mockFetcher,
  });
  const parsed = new URL(dyn.authorizeUrl);
  assert.equal(parsed.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(parsed.searchParams.get("resource"), "https://api.openai.com/v1");
  assert.equal(
    parsed.searchParams.get("ext_agent_host_id"),
    "urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  );
  assert.equal(parsed.searchParams.get("agent_name_hint"), "zumen-editor-web");
});

test("Same-Origin / CSRF 検査が他サイト要求を拒否する", () => {
  const config = makeConfig();
  const okReq = new Request("https://editor.zumen.dev/api/openai/v1/responses", {
    method: "POST",
    headers: { Origin: "https://editor.zumen.dev", "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(verifySameOriginRequest(okReq, config), null);

  const evilOrigin = new Request("https://editor.zumen.dev/api/openai/v1/responses", {
    method: "POST",
    headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
  });
  assert.notEqual(verifySameOriginRequest(evilOrigin, config), null);
});

test("本番環境で SESSION_SECRET 未設定でも 500 にせず SIWC 無効扱いで安全に遮断する", async () => {
  const env = process.env as Record<string, string | undefined>;
  const prevNodeEnv = env.NODE_ENV;
  const prevSecret = env.SESSION_SECRET;
  const prevClientId = env.OPENAI_SIWC_CLIENT_ID;
  try {
    env.NODE_ENV = "production";
    delete env.SESSION_SECRET;
    env.OPENAI_SIWC_CLIENT_ID = "oaiapp_test123";

    const cfg = loadSiwcConfig("https://editor.zumen.dev/auth/session");
    assert.equal(cfg.hasValidSessionSecret, false);
    assert.equal(cfg.isConfigured, false);
    assert.equal(cfg.sessionSecret, "");

    const req = new Request("https://editor.zumen.dev/auth/session");
    assert.equal(await readSessionFromRequest(req, cfg), null);

    await assert.rejects(() =>
      buildSessionCookie(
        {
          accessToken: "at",
          expiresAt: Date.now() + 60_000,
          clientId: "oaiapp_test123",
          scope: "openid",
          user: { sub: "u1" },
        },
        cfg,
      ),
    );
  } finally {
    if (prevNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = prevNodeEnv;
    if (prevSecret === undefined) delete env.SESSION_SECRET;
    else env.SESSION_SECRET = prevSecret;
    if (prevClientId === undefined) delete env.OPENAI_SIWC_CLIENT_ID;
    else env.OPENAI_SIWC_CLIENT_ID = prevClientId;
  }
});
