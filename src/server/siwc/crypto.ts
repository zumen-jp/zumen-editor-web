// Pure Web Crypto API によるステートレス暗号化 Cookie（AES-256-GCM）と PKCE S256 ユーティリティ。
// Node.js 24 と Cloudflare Workers（workerd）の双方で同一コードとして動作する。

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const FORMAT_PREFIX = "v1";

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(input: string): Uint8Array {
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(48);
  const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

async function deriveAesKey(secret: string, purpose: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ENCODER.encode("zumen-editor-web/siwc/v1"),
      info: ENCODER.encode(purpose),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealJson<T>(payload: T, secret: string, purpose: string): Promise<string> {
  const key = await deriveAesKey(secret, purpose);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plaintext = ENCODER.encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ENCODER.encode(purpose) },
    key,
    plaintext,
  );
  return `${FORMAT_PREFIX}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(encrypted))}`;
}

export async function unsealJson<T>(
  token: string | undefined | null,
  secret: string,
  purpose: string,
): Promise<T | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== FORMAT_PREFIX) return null;
  const ivPart = parts[1];
  const ctPart = parts[2];
  if (!ivPart || !ctPart) return null;
  try {
    const iv = base64UrlDecode(ivPart);
    const ciphertext = base64UrlDecode(ctPart);
    if (iv.byteLength !== 12 || ciphertext.byteLength < 16) return null;
    const key = await deriveAesKey(secret, purpose);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: ENCODER.encode(purpose) },
      key,
      ciphertext as BufferSource,
    );
    return JSON.parse(DECODER.decode(plain)) as T;
  } catch {
    return null;
  }
}

export function parseCookieHeader(header: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!header) return map;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) map.set(key, value);
  }
  return map;
}

export function formatSetCookie(
  name: string,
  value: string,
  options: {
    maxAgeSeconds: number;
    secure: boolean;
    httpOnly?: boolean;
    sameSite?: "Lax" | "Strict";
    path?: string;
  },
): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path ?? "/"}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    `SameSite=${options.sameSite ?? "Lax"}`,
  ];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}
