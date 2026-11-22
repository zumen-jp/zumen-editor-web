import type {
  Diagnostic,
  DrawingResult,
  Edit,
  Entity,
  Extent,
  SceneResult,
  TablesResult,
} from "@zumen-jp/zumen";

export const MAX_DRAWING_BYTES = 64 * 1024 * 1024;
export const DRAWING_DECODED_BUDGET = 512 * 1024 * 1024;

export type PaletteMode = "builtin" | "profile" | "none";

export type DrawingDiagnostic = {
  stage: "open" | "drawing" | "tables" | "scene" | "apply" | "check" | "render" | "export";
  code: string;
  severity: Diagnostic["severity"];
  count: number;
  text: string;
};

export type DrawingHistoryItem = {
  id: string;
  author: { kind: "user" } | { kind: "agent"; proposalId: string };
  summary: string;
  editCount: number;
  createdAt: number;
  idsShifted: boolean;
  diagnostics: DrawingDiagnostic[];
};

export type ProposalStatus = "pending" | "applied" | "dismissed" | "superseded" | "stale";

export type ProposalOverlayItem = {
  kind: Edit["kind"];
  id?: string;
  bbox?: Extent;
};

export type DrawingProposal = {
  id: string;
  path: string;
  baseHash: string;
  summary: string;
  edits: Edit[];
  status: ProposalStatus;
  dismissReason?: string;
  createdAt: number;
  appliedCount: number;
  diagnostics: DrawingDiagnostic[];
  overlays: ProposalOverlayItem[];
};

export type DrawingInfo = {
  path: string;
  version: string;
  format: string;
  hash: string;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  drawing: DrawingResult;
  tables: TablesResult;
  diagnostics: DrawingDiagnostic[];
  history: DrawingHistoryItem[];
  proposals: DrawingProposal[];
  defaultPlace: string;
};

export type DrawingSceneBundle = {
  path: string;
  version: string;
  doc: string;
  format: string;
  hash: string;
  place: string;
  result: SceneResult;
  blob: Uint8Array;
  diagnostics: DrawingDiagnostic[];
};

export type CheckProfileMeta = {
  id: string;
  edition: string;
  title: string;
  revision: number;
};

export type CheckGroupSummary = {
  ruleId: string;
  check: string;
  severity: string;
  count: number;
  sampleElements: string[];
  sampleMessages: string[];
};

export type DrawingCheckReport = {
  path: string;
  profile: CheckProfileMeta;
  totalFindings: number;
  unresolvedCount: number;
  groups: CheckGroupSummary[];
  diagnostics: DrawingDiagnostic[];
};

export type SelectedElementSummary = {
  id: string;
  kind?: string;
  layer?: string;
  bbox?: Extent;
};

export type SelectionAttachment = {
  path: string;
  place: string;
  elements: SelectedElementSummary[];
  total: number;
};

export type ViewCommand =
  | { type: "open"; path: string; line?: number; endLine?: number }
  | { type: "focus"; path: string; elements?: string[]; region?: [number, number, number, number] }
  | { type: "layers"; path: string; hide?: string[]; show?: string[]; solo?: string[] };

export type WorkspaceViewState = {
  activePath: string | null;
  openTabs: string[];
  activeDrawing?: {
    path: string;
    place: string;
    selectedIds: string[];
    hiddenLayers: string[];
  };
  activeText?: {
    path: string;
    selectedText?: string;
    startLine?: number;
    endLine?: number;
  };
};

export type EntityListResult = {
  items: Entity[];
  total: number;
  nextOffset?: number;
};
