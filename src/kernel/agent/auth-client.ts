import OpenAI from "openai";
import type { AuthSessionState, SiwcUserProfile } from "./types";

const AUTH_BROADCAST_CHANNEL = "zumen-siwc-auth";

type ServerSessionResponse = {
  signedIn: boolean;
  siwcConfigured: boolean;
  user: SiwcUserProfile | null;
  expiresAt: number | null;
  hasPlanUsageScope: boolean;
};

/** 開発検証用 BYOK キーはメモリ内にのみ保持し、localStorage や IndexedDB には一切書き出さない。 */
let memoryByokKey: string | null = null;
let inflightRefresh: Promise<AuthSessionState> | null = null;

export function setByokApiKey(key: string | null): void {
  const trimmed = key?.trim() ?? "";
  memoryByokKey = trimmed.length > 0 ? trimmed : null;
}

export function hasByokApiKey(): boolean {
  return memoryByokKey !== null;
}

export async function fetchAuthState(): Promise<AuthSessionState> {
  let server: ServerSessionResponse = {
    signedIn: false,
    siwcConfigured: false,
    user: null,
    expiresAt: null,
    hasPlanUsageScope: false,
  };
  try {
    const res = await fetch("/auth/session", { cache: "no-store", credentials: "same-origin" });
    if (res.ok) {
      server = (await res.json()) as ServerSessionResponse;
    }
  } catch {
    // オフライン時は未認証扱い
  }

  if (server.signedIn) {
    return {
      mode: "siwc",
      siwcConfigured: server.siwcConfigured,
      hasPlanUsageScope: server.hasPlanUsageScope,
      user: server.user,
      expiresAt: server.expiresAt,
    };
  }
  if (memoryByokKey) {
    return {
      mode: "byok",
      siwcConfigured: server.siwcConfigured,
      hasPlanUsageScope: false,
      user: { sub: "byok-local", name: "BYOK（開発用メモリ内 API キー）" },
      expiresAt: null,
    };
  }
  return {
    mode: "none",
    siwcConfigured: server.siwcConfigured,
    hasPlanUsageScope: false,
    user: null,
    expiresAt: null,
  };
}

/**
 * ポップアップ ＋ BroadcastChannel で SIWC ログインを行う。
 * 作業中の図面メモリ・未保存変更・FileSystemDirectoryHandle を維持したまま認証を完了できる。
 */
export function loginWithSiwcPopup(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const popup = window.open(
      "/auth/chatgpt?popup=1",
      "zumen_siwc_login",
      "width=520,height=680,menubar=no,toolbar=no,status=no",
    );
    if (!popup) {
      // ポップアップがブロックされた場合のみ同タブ遷移へフォールバック
      window.location.href = "/auth/chatgpt?popup=0";
      return;
    }

    let settled = false;
    const channel = new BroadcastChannel(AUTH_BROADCAST_CHANNEL);
    const finish = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      channel.close();
      resolve(result);
    };

    channel.onmessage = (event: MessageEvent<{ ok?: boolean; error?: string }>) => {
      finish({ ok: event.data?.ok === true, error: event.data?.error });
    };

    const pollTimer = setInterval(() => {
      if (popup.closed) {
        void fetchAuthState().then((state) => {
          finish(
            state.mode === "siwc"
              ? { ok: true }
              : { ok: false, error: "ログインウィンドウが閉じられました。" },
          );
        });
      }
    }, 400);
  });
}

export async function refreshSiwcSessionClient(): Promise<AuthSessionState> {
  if (!inflightRefresh) {
    inflightRefresh = (async () => {
      await fetch("/auth/refresh", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      }).catch(() => undefined);
      return fetchAuthState();
    })().finally(() => {
      inflightRefresh = null;
    });
  }
  return inflightRefresh;
}

export async function logoutAuth(): Promise<void> {
  memoryByokKey = null;
  await fetch("/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  }).catch(() => undefined);
}

/**
 * ログイン中のアカウント／プランで利用可能なモデル一覧を動的取得する。
 */
export async function fetchAvailableModels(auth: AuthSessionState): Promise<string[]> {
  if (auth.mode === "none") return [];
  const url = auth.mode === "siwc" ? "/api/openai/v1/models" : "https://api.openai.com/v1/models";
  const headers: HeadersInit =
    auth.mode === "byok" && memoryByokKey
      ? { Authorization: `Bearer ${memoryByokKey}`, Accept: "application/json" }
      : { Accept: "application/json" };

  const res = await fetch(url, {
    method: "GET",
    headers,
    credentials: auth.mode === "siwc" ? "same-origin" : "omit",
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`モデル一覧を取得できませんでした（HTTP ${res.status}）。`);
  }
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (body.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const filtered = ids.filter(
    (id) =>
      !id.includes("embedding") &&
      !id.includes("whisper") &&
      !id.includes("tts") &&
      !id.includes("dall-e") &&
      !id.includes("moderation") &&
      !id.includes("realtime"),
  );
  return (filtered.length > 0 ? filtered : ids).sort();
}

export function createBrowserOpenAIClient(auth: AuthSessionState): OpenAI {
  if (auth.mode === "siwc") {
    return new OpenAI({
      apiKey: "siwc-cookie",
      baseURL: `${window.location.origin}/api/openai/v1`,
      dangerouslyAllowBrowser: true,
      fetch: (input, init) => fetch(input, { ...init, credentials: "same-origin" }),
    });
  }
  if (auth.mode === "byok" && memoryByokKey) {
    return new OpenAI({
      apiKey: memoryByokKey,
      baseURL: "https://api.openai.com/v1",
      dangerouslyAllowBrowser: true,
    });
  }
  throw new Error("ChatGPT でログインするか、開発用 API キー（BYOK）を設定してください。");
}
