"use client";

import {
  AlertCircle,
  Check,
  CheckCircle2,
  Loader2,
  Paperclip,
  Plus,
  RotateCcw,
  Send,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AuthSessionState,
  ChatMessage,
  ChatSessionRecord,
  PendingQuestion,
  QuestionAnswer,
  RunState,
  ToolCallItem,
  TurnItem,
} from "@/kernel/agent/types";
import type { DrawingProposal, SelectionAttachment } from "@/kernel/drawing/types";
import type { ActionProposal } from "@/kernel/operations/types";

type ChatPaneProps = {
  widthPx: number;
  auth: AuthSessionState;
  sessions: ChatSessionRecord[];
  activeSessionId: string;
  messages: ChatMessage[];
  activeRun: RunState | null;
  attachment: SelectionAttachment | null;
  proposalsById: ReadonlyMap<string, DrawingProposal>;
  actionsById: ReadonlyMap<string, ActionProposal>;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
  onClearAttachment: () => void;
  onSend: (prompt: string) => void;
  onStop: () => void;
  onAnswerQuestion: (questionId: string, answer: QuestionAnswer) => void;
  onApplyProposal: (path: string, proposalId: string) => void;
  onDismissProposal: (path: string, proposalId: string) => void;
  onExecuteAction: (actionId: string) => void;
  onDismissAction: (actionId: string) => void;
  onRevertTextChange: (changeId: string) => void;
  onOpenFile: (path: string) => void;
  onOpenAuthDialog: () => void;
};

export function ChatPane({
  widthPx,
  auth,
  sessions,
  activeSessionId,
  messages,
  activeRun,
  attachment,
  proposalsById,
  actionsById,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onClearAttachment,
  onSend,
  onStop,
  onAnswerQuestion,
  onApplyProposal,
  onDismissProposal,
  onExecuteAction,
  onDismissAction,
  onRevertTextChange,
  onOpenFile,
  onOpenAuthDialog,
}: ChatPaneProps) {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  const scrollKey = `${messages.length}:${activeRun?.items.length ?? 0}:${activeRun?.question?.id ?? ""}`;
  useEffect(() => {
    if (scrollKey) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [scrollKey]);

  const submit = () => {
    const trimmed = input.trim();
    if (!trimmed || activeRun) return;
    setInput("");
    onSend(trimmed);
  };

  return (
    <aside className="pane pane-chat" style={{ width: widthPx }}>
      <div className="sub-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
          <select
            value={activeSessionId}
            onChange={(e) => onSelectSession(e.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              height: 27,
              padding: "0 6px",
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              background: "#fff",
              fontSize: 12,
            }}
            aria-label="会話を選択"
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={onNewSession} title="新しい会話">
            <Plus size={13} />
          </button>
          {sessions.length > 1 && (
            <button
              type="button"
              className="btn"
              onClick={() => onDeleteSession(activeSessionId)}
              title="この会話を削除"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="chat-messages">
        {messages.length === 0 && !activeRun && (
          <div style={{ padding: "18px 8px", color: "#475569", lineHeight: 1.7 }}>
            <p style={{ fontWeight: 700, color: "#0f172a", margin: "0 0 8px" }}>
              図面とファイルを会話で読み・調べ・直す
            </p>
            <p style={{ margin: "0 0 8px", fontSize: 12.5 }}>例:</p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
              <li>「A-01_1F平面図.dxf の各室と建具符号を 仕上表・建具表.csv と照合して」</li>
              <li>「CAD製図基準でチェックして、直せる指摘の変更案を出して」</li>
              <li>「応接室の円形テーブルを X+350 移動する変更案を作って」</li>
            </ul>
            {auth.mode === "none" && (
              <div style={{ marginTop: 12 }}>
                <button type="button" className="btn btn-accent" onClick={onOpenAuthDialog}>
                  ChatGPT でログイン / API キー設定
                </button>
              </div>
            )}
          </div>
        )}

        {messages.map((msg) =>
          msg.role === "user" ? (
            <div key={msg.id} className="msg-user">
              {msg.attachment && (
                <div style={{ fontSize: 11, opacity: 0.9, marginBottom: 4 }}>
                  添付選択: {msg.attachment.path}（{msg.attachment.total} 件）
                </div>
              )}
              {msg.text}
            </div>
          ) : (
            <div key={msg.id} className="msg-assistant">
              {msg.items.map((item) => (
                <TurnItemView
                  key={item.id}
                  item={item}
                  proposalsById={proposalsById}
                  actionsById={actionsById}
                  onApplyProposal={onApplyProposal}
                  onDismissProposal={onDismissProposal}
                  onExecuteAction={onExecuteAction}
                  onDismissAction={onDismissAction}
                  onRevertTextChange={onRevertTextChange}
                  onOpenFile={onOpenFile}
                />
              ))}
              {msg.stopped && <span className="badge badge-warn">実行を停止しました</span>}
              {msg.error && (
                <div className="tool-card" style={{ borderColor: "#fecaca", color: "#b91c1c" }}>
                  {msg.error}
                </div>
              )}
            </div>
          ),
        )}

        {activeRun && (
          <div className="msg-assistant">
            {activeRun.items.map((item) => (
              <TurnItemView
                key={item.id}
                item={item}
                proposalsById={proposalsById}
                actionsById={actionsById}
                onApplyProposal={onApplyProposal}
                onDismissProposal={onDismissProposal}
                onExecuteAction={onExecuteAction}
                onDismissAction={onDismissAction}
                onRevertTextChange={onRevertTextChange}
                onOpenFile={onOpenFile}
              />
            ))}
            {activeRun.question && (
              <QuestionCard
                question={activeRun.question}
                onAnswer={(ans) => onAnswerQuestion(activeRun.question!.id, ans)}
              />
            )}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                color: "#64748b",
                fontSize: 12,
              }}
            >
              <Loader2 size={13} className="spin" />
              <span>{activeRun.status === "stopping" ? "停止中..." : "応答を生成中..."}</span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="chat-composer">
        {attachment && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "4px 8px",
              borderRadius: 6,
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              fontSize: 11.5,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Paperclip size={12} />
              <span>
                {attachment.path} の選択 {attachment.total} 件を添付
              </span>
            </span>
            <button
              type="button"
              className="tab-close"
              onClick={onClearAttachment}
              aria-label="添付を外す"
            >
              <X size={12} />
            </button>
          </div>
        )}

        <textarea
          className="chat-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            auth.mode === "none"
              ? "先に ChatGPT ログイン（または開発用 API キー設定）を行ってください..."
              : "図面やファイルへの依頼を入力（Enter で送信、Shift+Enter で改行）"
          }
          disabled={auth.mode === "none"}
        />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "#64748b" }}>
            {auth.mode === "siwc"
              ? "ChatGPT プラン利用枠（store: false）"
              : auth.mode === "byok"
                ? "開発用 BYOK（メモリ内キー）"
                : "未ログイン"}
          </span>

          {activeRun ? (
            <button type="button" className="btn btn-danger" onClick={onStop}>
              <Square size={12} />
              <span>停止</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-accent"
              disabled={auth.mode === "none" || !input.trim()}
              onClick={submit}
            >
              <Send size={13} />
              <span>送信</span>
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function TurnItemView(props: {
  item: TurnItem;
  proposalsById: ReadonlyMap<string, DrawingProposal>;
  actionsById: ReadonlyMap<string, ActionProposal>;
  onApplyProposal: (path: string, proposalId: string) => void;
  onDismissProposal: (path: string, proposalId: string) => void;
  onExecuteAction: (actionId: string) => void;
  onDismissAction: (actionId: string) => void;
  onRevertTextChange: (changeId: string) => void;
  onOpenFile: (path: string) => void;
}) {
  if (props.item.kind === "text") {
    return (
      <div className="msg-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.item.text}</ReactMarkdown>
      </div>
    );
  }
  return <ToolCard {...props} item={props.item} />;
}

function ToolCard({
  item,
  proposalsById,
  actionsById,
  onApplyProposal,
  onDismissProposal,
  onExecuteAction,
  onDismissAction,
  onRevertTextChange,
  onOpenFile,
}: {
  item: ToolCallItem;
  proposalsById: ReadonlyMap<string, DrawingProposal>;
  actionsById: ReadonlyMap<string, ActionProposal>;
  onApplyProposal: (path: string, proposalId: string) => void;
  onDismissProposal: (path: string, proposalId: string) => void;
  onExecuteAction: (actionId: string) => void;
  onDismissAction: (actionId: string) => void;
  onRevertTextChange: (changeId: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const proposal = item.proposal ? (proposalsById.get(item.proposal.id) ?? item.proposal) : null;
  const action = item.action ? (actionsById.get(item.action.id) ?? item.action) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="tool-card">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {item.status === "running" ? (
            <Loader2 size={13} color="#2563eb" />
          ) : item.status === "error" ? (
            <AlertCircle size={13} color="#b91c1c" />
          ) : (
            <Wrench size={13} color="#475569" />
          )}
          <span style={{ fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
            {item.summary}
          </span>
          {item.path && (
            <button type="button" className="btn" onClick={() => onOpenFile(item.path!)}>
              開く
            </button>
          )}
        </div>
        {item.error && (
          <div style={{ marginTop: 4, color: "#b91c1c", fontSize: 11.5 }}>{item.error}</div>
        )}
      </div>

      {proposal && (
        <div className="proposal-card">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
            }}
          >
            <strong>図面の変更案（{proposal.appliedCount} 件）</strong>
            <span
              className={`badge ${
                proposal.status === "applied"
                  ? "badge-ok"
                  : proposal.status === "pending"
                    ? "badge-warn"
                    : ""
              }`}
            >
              {proposal.status === "pending"
                ? "未適用"
                : proposal.status === "applied"
                  ? "適用済み"
                  : proposal.status === "dismissed"
                    ? "却下済み"
                    : "失効"}
            </span>
          </div>
          <p style={{ margin: "6px 0 0", lineHeight: 1.5 }}>{proposal.summary}</p>
          {proposal.diagnostics.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 11.5, color: "#b45309" }}>
              診断: {proposal.diagnostics.map((d) => d.text).join(" / ")}
            </div>
          )}
          {proposal.status === "pending" && (
            <div className="card-actions">
              <button
                type="button"
                className="btn btn-ok"
                onClick={() => onApplyProposal(proposal.path, proposal.id)}
              >
                <Check size={13} />
                <span>図面へ当てる</span>
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => onDismissProposal(proposal.path, proposal.id)}
              >
                退ける
              </button>
            </div>
          )}
        </div>
      )}

      {action && (
        <div className="proposal-card">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
            }}
          >
            <strong>確認の札: {action.title}</strong>
            <span
              className={`badge ${
                action.status === "executed"
                  ? "badge-ok"
                  : action.status === "failed"
                    ? "badge-err"
                    : action.status === "pending"
                      ? "badge-warn"
                      : ""
              }`}
            >
              {action.status === "pending"
                ? "確認待ち"
                : action.status === "executed"
                  ? "実行済み"
                  : action.status === "dismissed"
                    ? "却下済み"
                    : "失敗"}
            </span>
          </div>
          <p style={{ margin: "6px 0 0", lineHeight: 1.5 }}>{action.summary}</p>
          {action.resultMessage && (
            <div style={{ marginTop: 4, color: "#15803d", fontSize: 11.5 }}>
              <CheckCircle2 size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
              {action.resultMessage}
            </div>
          )}
          {action.errorMessage && (
            <div style={{ marginTop: 4, color: "#b91c1c", fontSize: 11.5 }}>
              {action.errorMessage}
            </div>
          )}
          {action.status === "pending" && (
            <div className="card-actions">
              <button
                type="button"
                className="btn btn-ok"
                onClick={() => onExecuteAction(action.id)}
              >
                <Check size={13} />
                <span>実行する</span>
              </button>
              <button type="button" className="btn" onClick={() => onDismissAction(action.id)}>
                退ける
              </button>
            </div>
          )}
        </div>
      )}

      {item.textChange && (
        <div className="tool-card">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
            }}
          >
            <span>テキスト更新: {item.textChange.path}</span>
            <button
              type="button"
              className="btn"
              disabled={item.textChange.reverted}
              onClick={() => onRevertTextChange(item.textChange!.id)}
            >
              <RotateCcw size={12} />
              <span>{item.textChange.reverted ? "復元済み" : "元に戻す"}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function QuestionCard({
  question,
  onAnswer,
}: {
  question: PendingQuestion;
  onAnswer: (answer: QuestionAnswer) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState("");

  const toggle = (label: string) => {
    if (question.allowMultiple) {
      setSelected((prev) =>
        prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label],
      );
    } else {
      onAnswer({ choices: [label] });
    }
  };

  return (
    <div className="question-card">
      <div style={{ fontWeight: 700, marginBottom: 6 }}>エージェントからの確認</div>
      <p style={{ margin: "0 0 8px", lineHeight: 1.5 }}>{question.question}</p>
      {question.options && question.options.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
          {question.options.map((opt) => (
            <button
              key={opt.label}
              type="button"
              className={`btn ${selected.includes(opt.label) ? "active" : ""}`}
              style={{ justifyContent: "flex-start", height: "auto", padding: "6px 8px" }}
              onClick={() => toggle(opt.label)}
            >
              <span>
                <strong>{opt.label}</strong>
                {opt.description ? ` — ${opt.description}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder="自由入力で回答..."
          style={{
            flex: 1,
            height: 28,
            padding: "0 8px",
            borderRadius: 6,
            border: "1px solid #cbd5e1",
            background: "#fff",
          }}
        />
        <button
          type="button"
          className="btn btn-accent"
          disabled={selected.length === 0 && !freeText.trim()}
          onClick={() =>
            onAnswer({
              choices: selected,
              ...(freeText.trim() ? { text: freeText.trim() } : {}),
            })
          }
        >
          回答
        </button>
      </div>
    </div>
  );
}
