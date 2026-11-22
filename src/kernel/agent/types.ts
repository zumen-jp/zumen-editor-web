import type { AgentInputItem } from "@openai/agents";
import type { DrawingProposal, SelectionAttachment } from "../drawing/types";
import type { TextChangeRecord } from "../fs/types";
import type { ActionProposal } from "../operations/types";

export type AuthMode = "siwc" | "byok" | "none";

export type SiwcUserProfile = {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
};

export type AuthSessionState = {
  mode: AuthMode;
  siwcConfigured: boolean;
  hasPlanUsageScope: boolean;
  user: SiwcUserProfile | null;
  expiresAt: number | null;
};

export type ToolCallStatus = "running" | "done" | "error";

export type ToolCallItem = {
  kind: "tool";
  id: string;
  name: string;
  status: ToolCallStatus;
  summary: string;
  path?: string;
  elements?: string[];
  proposal?: DrawingProposal;
  action?: ActionProposal;
  textChange?: TextChangeRecord;
  detail?: string;
  error?: string;
};

export type TextItem = {
  kind: "text";
  id: string;
  text: string;
};

export type TurnItem = TextItem | ToolCallItem;

export type PendingQuestion = {
  id: string;
  question: string;
  options?: { label: string; description?: string }[];
  allowMultiple?: boolean;
};

export type QuestionAnswer = {
  choices: string[];
  text?: string;
};

export type ChatMessage =
  | {
      id: string;
      role: "user";
      text: string;
      attachment?: SelectionAttachment;
    }
  | {
      id: string;
      role: "assistant";
      items: TurnItem[];
      error?: string;
      stopped?: boolean;
    };

export type RunStatus = "running" | "stopping" | "done" | "stopped" | "error";

export type RunState = {
  runId: string;
  status: RunStatus;
  prompt: string;
  attachment?: SelectionAttachment;
  items: TurnItem[];
  question?: PendingQuestion;
  error?: string;
  model: string;
  startedAt: number;
  finishedAt?: number;
};

export type ChatSessionRecord = {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  modelItems: AgentInputItem[];
};
