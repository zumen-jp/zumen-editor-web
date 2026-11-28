import { z } from "zod";
import { extensionOf, isDrawingPath } from "../fs/paths";
import { guardTextWriteTarget, guardWorkspacePath } from "./guard";
import { type ActionDetail, type ActionKind, type ActionRequest, OperationError } from "./types";

const pathField = z.string().min(1);

/**
 * 確認の札の引数スキーマ。未知のキーは拒否する。
 * 競合を無視する上書き（force）はここに含めない。選べるのは札の上の利用者だけとする。
 */
const ACTION_ARG_SCHEMAS = {
  create_drawing: z.strictObject({
    path: pathField,
    unit: z.enum(["millimeter", "meter"]).optional(),
  }),
  save_drawing: z.strictObject({ path: pathField }),
  export_drawing: z.strictObject({
    path: pathField,
    targetPath: pathField,
    format: z.enum(["dxf", "svg", "png"]),
  }),
  create_folder: z.strictObject({ path: pathField }),
  rename_entry: z.strictObject({ path: pathField, to: pathField }),
  delete_entry: z.strictObject({ path: pathField }),
  convert_encoding: z.strictObject({
    path: pathField,
    encoding: z.enum(["utf-8", "shift_jis", "utf-16le", "utf-16be"]).optional(),
    eol: z.enum(["lf", "crlf"]).optional(),
    bom: z.boolean().optional(),
  }),
} satisfies Record<ActionKind, z.ZodType>;

function parseArgs<K extends ActionKind>(
  kind: K,
  rawArgs: unknown,
): z.output<(typeof ACTION_ARG_SCHEMAS)[K]> {
  const parsed = ACTION_ARG_SCHEMAS[kind].safeParse(rawArgs ?? {});
  if (parsed.success) return parsed.data as z.output<(typeof ACTION_ARG_SCHEMAS)[K]>;

  const problems = parsed.error.issues.map((issue) => {
    if (issue.code === "unrecognized_keys") {
      if (issue.keys.includes("force")) {
        return "force は指定できません（競合時の上書きは利用者が札の上で選びます）";
      }
      return `未対応の引数です: ${issue.keys.join(", ")}`;
    }
    const where = issue.path.join(".");
    return where ? `${where}: ${issue.message}` : issue.message;
  });
  throw new OperationError(
    "bad_request",
    `確認の札（${kind}）の引数が正しくありません: ${problems.join("; ")}`,
  );
}

function requireDrawingPath(rawPath: string): string {
  const path = guardWorkspacePath(rawPath);
  if (!isDrawingPath(path)) {
    throw new OperationError("bad_request", `図面ファイルではありません: ${path}`);
  }
  return path;
}

/**
 * エージェントが渡した引数を種別ごとに検証し、実行時にそのまま使う正規化済みの値へ変換する。
 * 札に表示する内容と実行される内容を一致させるため、実行側はこの戻り値だけを使う。
 */
export function validateActionArgs(kind: ActionKind, rawArgs: unknown): ActionRequest {
  switch (kind) {
    case "create_drawing": {
      const args = parseArgs(kind, rawArgs);
      const path = guardWorkspacePath(args.path);
      if (extensionOf(path) !== "dxf") {
        throw new OperationError("bad_request", `新規図面の保存先は .dxf にしてください: ${path}`);
      }
      return { kind, params: { path, unit: args.unit ?? "millimeter" } };
    }
    case "save_drawing": {
      const args = parseArgs(kind, rawArgs);
      return { kind, params: { path: requireDrawingPath(args.path) } };
    }
    case "export_drawing": {
      const args = parseArgs(kind, rawArgs);
      const path = requireDrawingPath(args.path);
      const targetPath = guardWorkspacePath(args.targetPath);
      if (extensionOf(targetPath) !== args.format) {
        throw new OperationError(
          "bad_request",
          `書き出し先の拡張子を形式（.${args.format}）に合わせてください: ${targetPath}`,
        );
      }
      if (targetPath === path) {
        throw new OperationError(
          "bad_request",
          "書き出し先に元の図面と同じパスは指定できません（上書き保存は save_drawing を使う）。",
        );
      }
      return { kind, params: { path, targetPath, format: args.format } };
    }
    case "create_folder": {
      const args = parseArgs(kind, rawArgs);
      return { kind, params: { path: guardWorkspacePath(args.path) } };
    }
    case "rename_entry": {
      const args = parseArgs(kind, rawArgs);
      const path = guardWorkspacePath(args.path);
      const to = guardWorkspacePath(args.to);
      if (path === to) {
        throw new OperationError("bad_request", "変更前と変更後のパスが同じです。");
      }
      return { kind, params: { path, to } };
    }
    case "delete_entry": {
      const args = parseArgs(kind, rawArgs);
      return { kind, params: { path: guardWorkspacePath(args.path) } };
    }
    case "convert_encoding": {
      const args = parseArgs(kind, rawArgs);
      const path = guardTextWriteTarget(args.path);
      if (args.encoding === undefined && args.eol === undefined && args.bom === undefined) {
        throw new OperationError(
          "bad_request",
          "encoding・eol・bom のうち、変換するものを 1 つ以上指定してください。",
        );
      }
      return {
        kind,
        params: {
          path,
          ...(args.encoding !== undefined ? { encoding: args.encoding } : {}),
          ...(args.eol !== undefined ? { eol: args.eol } : {}),
          ...(args.bom !== undefined ? { bom: args.bom } : {}),
        },
      };
    }
  }
}

const UNIT_LABELS = { millimeter: "ミリメートル", meter: "メートル" } as const;
const ENCODING_LABELS = {
  "utf-8": "UTF-8",
  shift_jis: "Shift_JIS",
  "utf-16le": "UTF-16LE",
  "utf-16be": "UTF-16BE",
} as const;
const KEEP = "変更しない";

/**
 * 札に表示する「実行内容」。エージェントの要約文ではなく、実行時に使う値からカーネルが組み立てる。
 */
export function describeActionRequest(request: ActionRequest): ActionDetail[] {
  switch (request.kind) {
    case "create_drawing":
      return [
        { label: "作成先", value: request.params.path },
        { label: "単位", value: UNIT_LABELS[request.params.unit] },
      ];
    case "save_drawing":
      return [{ label: "上書き先", value: request.params.path }];
    case "export_drawing":
      return [
        { label: "元の図面", value: request.params.path },
        { label: "書き出し先", value: request.params.targetPath },
        { label: "形式", value: request.params.format.toUpperCase() },
      ];
    case "create_folder":
      return [{ label: "作成先", value: request.params.path }];
    case "rename_entry":
      return [
        { label: "変更前", value: request.params.path },
        { label: "変更後", value: request.params.to },
      ];
    case "delete_entry":
      return [{ label: "削除対象", value: request.params.path }];
    case "convert_encoding": {
      const { path, encoding, eol, bom } = request.params;
      return [
        { label: "対象", value: path },
        { label: "文字コード", value: encoding ? ENCODING_LABELS[encoding] : KEEP },
        { label: "改行", value: eol ? eol.toUpperCase() : KEEP },
        { label: "BOM", value: bom === undefined ? KEEP : bom ? "付ける" : "付けない" },
      ];
    }
  }
}
