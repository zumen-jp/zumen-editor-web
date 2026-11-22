import {
  Agent,
  type AgentInputItem,
  OpenAIProvider,
  Runner,
  setTracingDisabled,
  user,
} from "@openai/agents";
import type { SelectionAttachment } from "../drawing/types";
import type { BrowserKernel } from "../operations/kernel";
import { createBrowserOpenAIClient } from "./auth-client";
import { pruneOldImagesFromInputItems } from "./compaction";
import { buildSystemInstructions } from "./prompt";
import { createBrowserAgentTools } from "./tools";
import type {
  AuthSessionState,
  PendingQuestion,
  QuestionAnswer,
  RunState,
  ToolCallItem,
} from "./types";

setTracingDisabled(true);

function formatSelectionBlock(attachment: SelectionAttachment): string {
  const lines = attachment.elements.slice(0, 30).map((e) => {
    const parts = [e.id];
    if (e.kind) parts.push(`kind=${e.kind}`);
    if (e.layer) parts.push(`layer=${e.layer}`);
    if (e.bbox) {
      parts.push(
        `bbox=[${e.bbox.min_x.toFixed(1)},${e.bbox.min_y.toFixed(1)},${e.bbox.max_x.toFixed(1)},${e.bbox.max_y.toFixed(1)}]`,
      );
    }
    return `- ${parts.join(" ")}`;
  });
  return `<drawing-selection path="${attachment.path}" place="${attachment.place}" total="${attachment.total}">\n${lines.join("\n")}\n</drawing-selection>`;
}

export type ActiveRunHandle = {
  runId: string;
  stop: () => void;
  answerQuestion: (questionId: string, answer: QuestionAnswer) => void;
  done: Promise<{ state: RunState; history: AgentInputItem[] }>;
};

/**
 * Chrome ブラウザ内で @openai/agents を直接実行するエージェントランタイム。
 * - SIWC モードでは同一オリジンの極薄 BFF（/api/openai/v1）経由、BYOK モードでは api.openai.com 直送。
 * - `store: false`・`stream: true`・過去画像プルーニング・`ask_user` 中断/再開・`AbortController` 停止を統合。
 */
export function startBrowserAgentRun(params: {
  kernel: BrowserKernel;
  auth: AuthSessionState;
  model: string;
  prompt: string;
  history: readonly AgentInputItem[];
  attachment?: SelectionAttachment;
  onUpdate: (state: RunState) => void;
}): ActiveRunHandle {
  const runId = crypto.randomUUID();
  const abort = new AbortController();
  let stopRequested = false;
  let pendingAsk: {
    question: PendingQuestion;
    resolve: (answer: QuestionAnswer | null) => void;
  } | null = null;

  const state: RunState = {
    runId,
    status: "running",
    prompt: params.prompt,
    attachment: params.attachment,
    items: [],
    model: params.model,
    startedAt: Date.now(),
  };

  const emit = () => {
    params.onUpdate({
      ...state,
      items: state.items.map((item) => ({ ...item })),
    });
  };

  const toolByCallId = new Map<string, ToolCallItem>();
  let latestRunningTool: ToolCallItem | null = null;

  const ensureTextItem = () => {
    const last = state.items[state.items.length - 1];
    if (last && last.kind === "text") return last;
    const created = { kind: "text" as const, id: crypto.randomUUID(), text: "" };
    state.items.push(created);
    return created;
  };

  const tools = createBrowserAgentTools(params.kernel, {
    askUser: (q) => {
      if (stopRequested || abort.signal.aborted) return Promise.resolve(null);
      const question: PendingQuestion = { id: crypto.randomUUID(), ...q };
      return new Promise<QuestionAnswer | null>((resolve) => {
        pendingAsk = { question, resolve };
        state.question = question;
        emit();
      });
    },
    onProposalCreated: (proposal) => {
      if (latestRunningTool) {
        latestRunningTool.proposal = proposal;
        latestRunningTool.path = proposal.path;
        emit();
      }
    },
    onActionCreated: (action) => {
      if (latestRunningTool) {
        latestRunningTool.action = action;
        emit();
      }
    },
    onTextChange: (change) => {
      if (latestRunningTool) {
        latestRunningTool.textChange = change;
        latestRunningTool.path = change.path;
        emit();
      }
    },
  });

  const done = (async (): Promise<{ state: RunState; history: AgentInputItem[] }> => {
    let nextHistory: AgentInputItem[] = [...params.history];
    try {
      const client = createBrowserOpenAIClient(params.auth);
      const provider = new OpenAIProvider({
        openAIClient: client,
        useResponses: true,
      });

      const agent = new Agent({
        name: "zumen-editor-assistant",
        instructions: buildSystemInstructions(),
        model: params.model,
        modelSettings: {
          store: false,
        },
        tools,
      });

      const runner = new Runner({
        modelProvider: provider,
        tracingDisabled: true,
        modelSettings: {
          store: false,
        },
      });

      const userPrompt = params.attachment
        ? `${params.prompt}\n\n${formatSelectionBlock(params.attachment)}`
        : params.prompt;
      const inputItems: AgentInputItem[] = [...params.history, user(userPrompt)];
      emit();

      const stream = await runner.run(agent, inputItems, {
        stream: true,
        maxTurns: 25,
        signal: abort.signal,
        callModelInputFilter: ({ modelData }) => ({
          ...modelData,
          input: pruneOldImagesFromInputItems(modelData.input, 2),
        }),
      });

      for await (const event of stream) {
        if (event.type === "raw_model_stream_event") {
          const data = event.data as Record<string, unknown>;
          if (data.type === "output_text_delta" && typeof data.delta === "string") {
            const textItem = ensureTextItem();
            textItem.text += data.delta;
            emit();
          }
        } else if (event.type === "run_item_stream_event") {
          if (event.name === "tool_called") {
            const raw = event.item.rawItem as {
              callId?: string;
              name?: string;
              arguments?: string;
            };
            const callId = raw.callId ?? crypto.randomUUID();
            let summary = raw.name ?? "tool";
            let targetPath: string | undefined;
            if (raw.arguments) {
              try {
                const parsed = JSON.parse(raw.arguments) as Record<string, unknown>;
                if (typeof parsed.path === "string") {
                  targetPath = parsed.path;
                  summary = `${raw.name}: ${parsed.path}`;
                } else if (typeof parsed.summary === "string") {
                  summary = `${raw.name}: ${parsed.summary}`;
                } else if (typeof parsed.query === "string") {
                  summary = `${raw.name}: ${parsed.query}`;
                }
              } catch {
                // ignore
              }
            }
            const item: ToolCallItem = {
              kind: "tool",
              id: callId,
              name: raw.name ?? "tool",
              status: "running",
              summary,
              ...(targetPath ? { path: targetPath } : {}),
            };
            toolByCallId.set(callId, item);
            latestRunningTool = item;
            state.items.push(item);
            emit();
          } else if (event.name === "tool_output") {
            const raw = event.item.rawItem as { callId?: string };
            const callId = raw.callId ?? "";
            const target: ToolCallItem | undefined =
              toolByCallId.get(callId) ?? latestRunningTool ?? undefined;
            if (target) {
              const rawOutput =
                event.item.type === "tool_call_output_item" ? event.item.output : "";
              const outputStr =
                typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
              try {
                const parsed = JSON.parse(outputStr) as { error?: string };
                if (typeof parsed.error === "string") {
                  target.status = "error";
                  target.error = parsed.error;
                } else {
                  target.status = "done";
                }
              } catch {
                target.status = "done";
              }
              if (latestRunningTool === target) latestRunningTool = null;
              emit();
            }
          }
        }
      }

      await stream.completed;
      nextHistory = pruneOldImagesFromInputItems(stream.history, 2);
      state.status = stopRequested ? "stopped" : "done";
      state.finishedAt = Date.now();
      emit();
    } catch (error) {
      if (stopRequested || abort.signal.aborted) {
        state.status = "stopped";
      } else {
        state.status = "error";
        state.error = error instanceof Error ? error.message : String(error);
      }
      state.finishedAt = Date.now();
      emit();
    } finally {
      const ask = pendingAsk as {
        question: PendingQuestion;
        resolve: (answer: QuestionAnswer | null) => void;
      } | null;
      if (ask) {
        pendingAsk = null;
        state.question = undefined;
        ask.resolve(null);
      }
    }
    return { state, history: nextHistory };
  })();

  return {
    runId,
    stop: () => {
      if (stopRequested) return;
      stopRequested = true;
      state.status = "stopping";
      if (pendingAsk) {
        const ask = pendingAsk;
        pendingAsk = null;
        state.question = undefined;
        ask.resolve(null);
      }
      abort.abort();
      emit();
    },
    answerQuestion: (questionId, answer) => {
      if (!pendingAsk || pendingAsk.question.id !== questionId) return;
      const ask = pendingAsk;
      pendingAsk = null;
      state.question = undefined;
      emit();
      ask.resolve(answer);
    },
    done,
  };
}
