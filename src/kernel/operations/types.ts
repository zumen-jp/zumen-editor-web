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

export type ActionProposal = {
  id: string;
  kind: ActionKind;
  title: string;
  summary: string;
  params: Record<string, unknown>;
  status: ActionProposalStatus;
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
