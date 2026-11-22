import type { SiwcConfig } from "./config";

/**
 * 状態変更や API プロキシ要求に対する Same-Origin / CSRF 検査。
 * 異なるサイトからのクロスオリジン要求を拒否する。
 */
export function verifySameOriginRequest(request: Request, config: SiwcConfig): string | null {
  const origin = request.headers.get("origin");
  const secFetchSite = request.headers.get("sec-fetch-site");

  if (secFetchSite !== null && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return "他サイトからの要求は受け付けません。";
  }

  if (origin !== null) {
    const expected = new URL(config.appOrigin).origin;
    let reqOrigin: string;
    try {
      reqOrigin = new URL(origin).origin;
    } catch {
      return "Origin ヘッダーの形式が不正です。";
    }
    if (reqOrigin !== expected) {
      // ローカル開発時の localhost / 127.0.0.1 同一ポート揺れのみ許容
      if (!config.isProduction && isSameLocalLoopbackPort(reqOrigin, expected)) {
        return null;
      }
      return "許可されていない Origin からの要求です。";
    }
  }

  return null;
}

function isSameLocalLoopbackPort(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
    return (
      ua.protocol === ub.protocol &&
      ua.port === ub.port &&
      loopback.has(ua.hostname) &&
      loopback.has(ub.hostname)
    );
  } catch {
    return false;
  }
}
