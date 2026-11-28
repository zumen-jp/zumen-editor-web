import type { Eol, TextEncoding } from "../fs/text-codec";

export type Actor = "human" | "agent";

export type OperationCategory = "read" | "view" | "edit" | "commit";

export const ACTION_KINDS = [
  "create_drawing",
  "save_drawing",
  "export_drawing",
  "create_folder",
  "rename_entry",
  "delete_entry",
  "convert_encoding",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export const ACTION_LABELS: Record<ActionKind, string> = {
  create_drawing: "新しい DXF 図面を作成して保存する",
  save_drawing: "図面の変更を元のファイルに上書き保存する",
  export_drawing: "図面を DXF / SVG / PNG に書き出す",
  create_folder: "新しいフォルダーを作る",
  rename_entry: "ファイルやフォルダーの名前を変える・移動する",
  delete_entry: "控えを残してファイルやフォルダーを削除する",
  convert_encoding: "テキストの文字コード・改行・BOM を変換して保存する",
};

export type ActionProposalStatus = "pending" | "executed" | "dismissed" | "failed";

/** 種別ごとの検証・正規化済み引数。実行時はこの値だけを使う。 */
export type ActionParamsByKind = {
  create_drawing: { path: string; unit: "millimeter" | "meter" };
  save_drawing: { path: string };
  export_drawing: { path: string; targetPath: string; format: "dxf" | "svg" | "png" };
  create_folder: { path: string };
  rename_entry: { path: string; to: string };
  delete_entry: { path: string };
  convert_encoding: { path: string; encoding?: TextEncoding; eol?: Eol; bom?: boolean };
};

export type ActionRequest = {
  [K in ActionKind]: { kind: K; params: ActionParamsByKind[K] };
}[ActionKind];

/** 札に表示する実行内容の 1 行。 */
export type ActionDetail = { label: string; value: string };

export type ActionProposal = ActionRequest & {
  id: string;
  title: string;
  /** エージェントが書いた説明。実行内容の根拠にはしない。 */
  summary: string;
  /** 実行時に使う値からカーネルが組み立てた表示用の明細。 */
  details: ActionDetail[];
  status: ActionProposalStatus;
  /** 保存先が外で変更されており、利用者の判断を待っている。 */
  conflict?: boolean;
  createdAt: number;
  resultMessage?: string;
  errorMessage?: string;
};

export class OperationError extends Error {
  constructor(
    readonly code:
      | "forbidden"
      | "bad_request"
      | "not_found"
      | "conflict"
      | "protected_file"
      | "too_large"
      | "failed",
    message: string,
  ) {
    super(message);
    this.name = "OperationError";
  }
}
