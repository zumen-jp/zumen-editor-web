"use client";

import {
  Download,
  ExternalLink,
  FolderOpen,
  HardDrive,
  KeyRound,
  LogIn,
  LogOut,
  PanelLeft,
  PanelRight,
  Redo2,
  Save,
  Sparkles,
  Undo2,
} from "lucide-react";
import type { AuthSessionState } from "@/kernel/agent/types";
import type { DrawingInfo } from "@/kernel/drawing/types";
import type { WorkspaceKind } from "@/kernel/fs/types";

type TopBarProps = {
  workspaceName: string;
  workspaceKind: WorkspaceKind;
  fsaSupported: boolean;
  activeDrawing: DrawingInfo | null;
  chatOpen: boolean;
  inspectorOpen: boolean;
  auth: AuthSessionState;
  models: string[];
  selectedModel: string;
  onToggleChat: () => void;
  onToggleInspector: () => void;
  onOpenLocalFolder: () => void;
  onSwitchOpfs: () => void;
  onCreateSampleDxf: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onExport: (format: "dxf" | "svg" | "png") => void;
  onSelectModel: (model: string) => void;
  onOpenAuthDialog: () => void;
  onQuickSiwcLogin: () => void;
  onLogout: () => void;
};

export function TopBar({
  workspaceName,
  workspaceKind,
  fsaSupported,
  activeDrawing,
  chatOpen,
  inspectorOpen,
  auth,
  models,
  selectedModel,
  onToggleChat,
  onToggleInspector,
  onOpenLocalFolder,
  onSwitchOpfs,
  onCreateSampleDxf,
  onUndo,
  onRedo,
  onSave,
  onExport,
  onSelectModel,
  onOpenAuthDialog,
  onQuickSiwcLogin,
  onLogout,
}: TopBarProps) {
  return (
    <header className="top-bar">
      <div className="top-bar-group">
        <button
          type="button"
          className="tb-btn"
          onClick={onToggleChat}
          title={chatOpen ? "チャットを閉じる" : "チャットを開く"}
        >
          <PanelLeft size={14} />
        </button>
        <span className="brand-title">
          <Sparkles size={14} color="#38bdf8" />
          <span>zumen editor web</span>
          <span className="brand-pill">Chrome 完結</span>
        </span>

        <button
          type="button"
          className="tb-btn"
          disabled={!fsaSupported}
          onClick={onOpenLocalFolder}
          title="Chrome File System Access API でローカルフォルダーを開く"
        >
          <FolderOpen size={14} />
          <span>フォルダーを開く</span>
        </button>

        <button
          type="button"
          className="tb-btn"
          onClick={onSwitchOpfs}
          title="ブラウザ内の一時領域（OPFS）へ切り替え"
        >
          <HardDrive size={14} />
          <span>{workspaceKind === "fsa" ? `ローカル: ${workspaceName}` : "OPFS 一時領域"}</span>
        </button>

        <button
          type="button"
          className="tb-btn"
          onClick={onCreateSampleDxf}
          title="RC造 1階平面図（DXF）・仕上表/建具表（CSV）・設計メモ（MD）のサンプル一式を作成"
        >
          <span>+ サンプル図面</span>
        </button>
      </div>

      {activeDrawing && (
        <div className="top-bar-group">
          <button
            type="button"
            className="tb-btn"
            disabled={!activeDrawing.canUndo}
            onClick={onUndo}
            title="取り消し"
          >
            <Undo2 size={14} />
          </button>
          <button
            type="button"
            className="tb-btn"
            disabled={!activeDrawing.canRedo}
            onClick={onRedo}
            title="やり直し"
          >
            <Redo2 size={14} />
          </button>
          <button
            type="button"
            className={`tb-btn ${activeDrawing.dirty ? "tb-btn-primary" : ""}`}
            disabled={!activeDrawing.dirty}
            onClick={onSave}
            title="保存（Ctrl+S）"
          >
            <Save size={14} />
            <span>保存</span>
          </button>
          <button
            type="button"
            className="tb-btn"
            onClick={() => onExport("dxf")}
            title="DXF に別名書き出し"
          >
            <Download size={14} />
            <span>DXF</span>
          </button>
          <button
            type="button"
            className="tb-btn"
            onClick={() => onExport("svg")}
            title="SVG に書き出し"
          >
            <span>SVG</span>
          </button>
        </div>
      )}

      <div className="top-bar-group">
        {auth.mode !== "none" && (
          <select
            className="tb-select"
            value={selectedModel}
            onChange={(e) => onSelectModel(e.target.value)}
            aria-label="使用モデル"
          >
            {models.length === 0 ? (
              <option value={selectedModel || "gpt-5.2"}>
                {selectedModel || "モデル読込中..."}
              </option>
            ) : (
              models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))
            )}
          </select>
        )}

        {auth.mode === "siwc" ? (
          <>
            <span className="brand-pill" title={auth.user?.email ?? auth.user?.sub}>
              ChatGPT プラン: {auth.user?.name || auth.user?.email || "接続中"}
            </span>
            <a
              href="https://chatgpt.com/#settings"
              target="_blank"
              rel="noreferrer"
              className="tb-btn"
              title="ChatGPT 設定で利用枠と権限を管理"
              style={{ textDecoration: "none" }}
            >
              <ExternalLink size={13} />
            </a>
            <button type="button" className="tb-btn" onClick={onLogout} title="ログアウト">
              <LogOut size={14} />
            </button>
          </>
        ) : auth.mode === "byok" ? (
          <>
            <button type="button" className="tb-btn" onClick={onOpenAuthDialog}>
              <KeyRound size={13} />
              <span>BYOK 接続中</span>
            </button>
            <button type="button" className="tb-btn" onClick={onLogout} title="API キー消去">
              <LogOut size={14} />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="tb-btn tb-btn-chatgpt"
              onClick={auth.siwcConfigured ? onQuickSiwcLogin : onOpenAuthDialog}
            >
              <LogIn size={14} />
              <span>Continue with ChatGPT</span>
            </button>
            <button
              type="button"
              className="tb-btn"
              onClick={onOpenAuthDialog}
              title="開発・検証用 API キー（BYOK）を設定"
            >
              <KeyRound size={13} />
            </button>
          </>
        )}

        <button
          type="button"
          className="tb-btn"
          onClick={onToggleInspector}
          title={inspectorOpen ? "右パネルを閉じる" : "右パネルを開く"}
        >
          <PanelRight size={14} />
        </button>
      </div>
    </header>
  );
}
