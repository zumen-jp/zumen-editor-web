export type SiwcConfig = {
  appOrigin: string;
  issuer: string;
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  hostId: string;
  agentName: string;
  scopes: string;
  resource: string;
  sessionSecret: string;
  hasValidSessionSecret: boolean;
  isProduction: boolean;
  isConfigured: boolean;
};

let devFallbackSecret: string | null = null;

function getDevFallbackSecret(): string {
  if (!devFallbackSecret) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    devFallbackSecret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return devFallbackSecret;
}

function normalizeOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function loadSiwcConfig(requestUrl?: string): SiwcConfig {
  const isProduction = process.env.NODE_ENV === "production";
  const envOrigin = process.env.APP_ORIGIN?.trim();
  let appOrigin = envOrigin ? normalizeOrigin(envOrigin) : "";
  if (!appOrigin && requestUrl) {
    try {
      appOrigin = normalizeOrigin(new URL(requestUrl).origin);
    } catch {
      appOrigin = "http://127.0.0.1:24120";
    }
  }
  if (!appOrigin) {
    appOrigin = "http://127.0.0.1:24120";
  }

  const rawSecret = process.env.SESSION_SECRET?.trim() ?? "";
  let sessionSecret = rawSecret;
  let hasValidSessionSecret = sessionSecret.length >= 32;
  if (!hasValidSessionSecret) {
    if (isProduction) {
      // 本番で SESSION_SECRET が未設定のときは弱い鍵へフォールバックせず、SIWC を無効扱いにする。
      sessionSecret = "";
    } else {
      sessionSecret = getDevFallbackSecret();
      hasValidSessionSecret = true;
    }
  }

  const clientId = process.env.OPENAI_SIWC_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.OPENAI_SIWC_CLIENT_SECRET?.trim() ?? "";
  const issuer = normalizeOrigin(
    process.env.OPENAI_SIWC_ISSUER?.trim() || "https://auth.openai.com",
  );
  const apiBaseUrl = normalizeOrigin(
    process.env.OPENAI_API_BASE_URL?.trim() || "https://api.openai.com/v1",
  );
  const scopes =
    process.env.OPENAI_SIWC_SCOPES?.trim() ||
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
  const hostId = process.env.OPENAI_SIWC_HOST_ID?.trim() || "";
  const agentName = process.env.OPENAI_SIWC_AGENT_NAME?.trim() || "zumen-editor-web";

  return {
    appOrigin,
    issuer,
    apiBaseUrl,
    clientId,
    clientSecret,
    hostId,
    agentName,
    scopes,
    resource: apiBaseUrl,
    sessionSecret,
    hasValidSessionSecret,
    isProduction,
    isConfigured: clientId.length > 0 && hasValidSessionSecret,
  };
}

export const SESSION_COOKIE_NAME = "zumen_siwc_session";
export const TX_COOKIE_NAME = "zumen_siwc_tx";
export const HOST_COOKIE_NAME = "zumen_siwc_host";
