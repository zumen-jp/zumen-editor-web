"use client";

import { ExternalLink, KeyRound, LogIn, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import type { AuthSessionState } from "@/kernel/agent/types";

type AuthDialogProps = {
  auth: AuthSessionState;
  onClose: () => void;
  onLoginSiwc: () => Promise<void>;
  onSaveByok: (apiKey: string) => Promise<void>;
  onLogout: () => Promise<void>;
};

export function AuthDialog({ auth, onClose, onLoginSiwc, onSaveByok, onLogout }: AuthDialogProps) {
  const [byokInput, setByokInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSiwc = async () => {
    setBusy(true);
    setError(null);
    try {
      await onLoginSiwc();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ログインに失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const handleByok = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = byokInput.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await onSaveByok(trimmed);
      setByokInput("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "API キーの設定に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="AI 認証設定">
      <div className="modal-card">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
            <ShieldCheck size={18} color="#2563eb" />
            <span>AI 接続と認証（SIWC / 開発用 BYOK）</span>
          </div>
          <button type="button" className="btn" onClick={onClose} aria-label="閉じる">
            <X size={14} />
          </button>
        </div>

        <p style={{ margin: "0 0 12px", color: "#475569", lineHeight: 1.6 }}>
          図面・表・テキストの読み書きと WebGPU 表示はすべてお使いの Chrome 内で完結します。 AI
          チャットを使うときだけ、依頼文とツール結果が OpenAI Responses API（
          <code>store: false</code>）へ送信されます。
        </p>

        {error && (
          <div
            style={{
              padding: "8px 10px",
              borderRadius: 6,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#b91c1c",
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
            background: "#f8fafc",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            1. Sign in with ChatGPT（推奨・規定）
          </div>
          <p style={{ margin: "0 0 10px", fontSize: 12, color: "#475569", lineHeight: 1.5 }}>
            ChatGPT アカウントでログインし、対象プラン（Plus / Pro
            等）の利用枠でエージェントを動かします。 認証トークンは暗号化 HttpOnly Cookie
            のみに保持され、サーバーにデータベースを持ちません。
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-accent"
              disabled={busy || !auth.siwcConfigured}
              onClick={handleSiwc}
            >
              <LogIn size={14} />
              <span>Continue with ChatGPT</span>
            </button>
            <a
              href="https://chatgpt.com/#settings"
              target="_blank"
              rel="noreferrer"
              className="btn"
              style={{ textDecoration: "none" }}
            >
              <ExternalLink size={13} />
              <span>ChatGPT 設定・利用枠を確認</span>
            </a>
          </div>
          {!auth.siwcConfigured && (
            <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "#b45309" }}>
              この環境の Sign in with ChatGPT（<code>OPENAI_SIWC_CLIENT_ID</code> /{" "}
              <code>SESSION_SECRET</code>）が未設定のため、下の開発用 BYOK モードをご利用ください。
            </p>
          )}
        </div>

        <form
          onSubmit={handleByok}
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            padding: 12,
            background: "#ffffff",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontWeight: 700,
              marginBottom: 6,
            }}
          >
            <KeyRound size={14} />
            <span>2. OpenAI API キー（開発・検証用 BYOK）</span>
          </div>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "#475569", lineHeight: 1.5 }}>
            SIWC パートナー審査待ちやローカル検証向けです。キーはブラウザのメモリ内だけに保持し、
            localStorage やサーバーへは一切保存しません（タブを閉じると消去されます）。
          </p>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="password"
              value={byokInput}
              onChange={(e) => setByokInput(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
              style={{
                flex: 1,
                height: 32,
                padding: "0 10px",
                borderRadius: 6,
                border: "1px solid #cbd5e1",
              }}
            />
            <button type="submit" className="btn btn-accent" disabled={busy || !byokInput.trim()}>
              設定
            </button>
          </div>
        </form>

        {auth.mode !== "none" && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await onLogout();
                setBusy(false);
                onClose();
              }}
            >
              ログアウト / 認証クリア
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
