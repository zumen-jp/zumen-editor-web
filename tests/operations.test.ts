import assert from "node:assert/strict";
import test from "node:test";
import type { AgentInputItem } from "@openai/agents";
import { pruneOldImagesFromInputItems } from "../src/kernel/agent/compaction";
import { AGENT_TOOL_NAMES } from "../src/kernel/agent/tools";
import { describeActionRequest, validateActionArgs } from "../src/kernel/operations/action-args";
import { guardTextWriteTarget, guardWorkspacePath } from "../src/kernel/operations/guard";
import { checkOperationSymmetry } from "../src/kernel/operations/ledger";
import { ACTION_KINDS, type ActionKind, OperationError } from "../src/kernel/operations/types";

test("操作台帳（OPERATIONS）がツール一覧・確認の札と完全に整合し commit 漏洩がない", () => {
  const problems = checkOperationSymmetry({
    agentTools: AGENT_TOOL_NAMES,
    actionKinds: ACTION_KINDS,
  });
  assert.deepEqual(problems, []);
});

test("パスガードが作業フォルダー外・絶対パス・予約名を拒否する", () => {
  assert.equal(guardWorkspacePath("drawings/plan.dxf"), "drawings/plan.dxf");
  assert.equal(guardWorkspacePath("./notes\\memo.txt"), "notes/memo.txt");

  for (const bad of [
    "../secret.txt",
    "a/../../outside.dxf",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "bad\0name.txt",
    "CON.txt",
  ]) {
    assert.throws(() => guardWorkspacePath(bad), `拒否すべきパスが通りました: ${bad}`);
  }
});

test("テキスト書き換えガードが図面・IFC への直接書き込みを拒否する", () => {
  assert.equal(guardTextWriteTarget("notes/spec.md"), "notes/spec.md");
  for (const protectedFile of [
    "plan.dxf",
    "detail.dwg",
    "house.jww",
    "bridge.sfc",
    "road.p21",
    "model.ifc",
    "archive.ifczip",
  ]) {
    assert.throws(
      () => guardTextWriteTarget(protectedFile),
      `保護対象がテキスト書込で通りました: ${protectedFile}`,
    );
  }
});

test("確認の札の引数を種別ごとに検証・正規化し、表示用の明細を実引数から組み立てる", () => {
  const exported = validateActionArgs("export_drawing", {
    path: ".\\drawings\\plan.dxf",
    targetPath: "out/plan.png",
    format: "png",
  });
  assert.deepEqual(exported, {
    kind: "export_drawing",
    params: { path: "drawings/plan.dxf", targetPath: "out/plan.png", format: "png" },
  });
  assert.deepEqual(describeActionRequest(exported), [
    { label: "元の図面", value: "drawings/plan.dxf" },
    { label: "書き出し先", value: "out/plan.png" },
    { label: "形式", value: "PNG" },
  ]);

  // 省略値も札に出る値として確定させる
  const created = validateActionArgs("create_drawing", { path: "new/plan.dxf" });
  assert.deepEqual(created.params, { path: "new/plan.dxf", unit: "millimeter" });
  assert.deepEqual(describeActionRequest(created), [
    { label: "作成先", value: "new/plan.dxf" },
    { label: "単位", value: "ミリメートル" },
  ]);

  const converted = validateActionArgs("convert_encoding", {
    path: "notes/memo.txt",
    encoding: "shift_jis",
  });
  assert.deepEqual(describeActionRequest(converted), [
    { label: "対象", value: "notes/memo.txt" },
    { label: "文字コード", value: "Shift_JIS" },
    { label: "改行", value: "変更しない" },
    { label: "BOM", value: "変更しない" },
  ]);

  assert.deepEqual(
    describeActionRequest(validateActionArgs("rename_entry", { path: "a.txt", to: "b/a.txt" })),
    [
      { label: "変更前", value: "a.txt" },
      { label: "変更後", value: "b/a.txt" },
    ],
  );
});

test("確認の札は force・未知のキー・不正な値を札を出す前に拒否する", () => {
  const rejected: Array<[ActionKind, unknown, RegExp]> = [
    // 競合を無視する上書きはエージェントから指定できない
    ["save_drawing", { path: "plan.dxf", force: true }, /force は指定できません/],
    ["delete_entry", { path: "plan.dxf", recursive: true }, /未対応の引数です: recursive/],
    ["save_drawing", {}, /path/],
    ["save_drawing", { path: "notes/memo.txt" }, /図面ファイルではありません/],
    ["delete_entry", { path: "../outside.dxf" }, /作業フォルダーの外/],
    ["rename_entry", { path: "a.txt", to: "C:\\Windows\\a.txt" }, /作業フォルダーの外/],
    ["rename_entry", { path: "a.txt", to: "./a.txt" }, /同じ/],
    ["create_drawing", { path: "new/plan.dwg" }, /\.dxf/],
    ["create_drawing", { path: "new/plan.dxf", unit: "inch" }, /unit/],
    ["export_drawing", { path: "plan.dxf", targetPath: "plan.dxf", format: "png" }, /拡張子/],
    ["export_drawing", { path: "plan.dxf", targetPath: "plan.dxf", format: "dxf" }, /同じパス/],
    ["export_drawing", { path: "plan.dxf", targetPath: "plan.svg" }, /format/],
    ["convert_encoding", { path: "notes/memo.txt" }, /1 つ以上/],
    [
      "convert_encoding",
      { path: "plan.dxf", encoding: "utf-8" },
      /テキストツールで直接書き換えられません/,
    ],
    ["convert_encoding", { path: "notes/memo.txt", encoding: "euc-jp" }, /encoding/],
    ["create_folder", "drawings", /引数が正しくありません/],
  ];
  for (const [kind, args, pattern] of rejected) {
    assert.throws(
      () => validateActionArgs(kind, args),
      (error: unknown) => error instanceof OperationError && pattern.test(error.message),
      `拒否すべき引数が通りました: ${kind} ${JSON.stringify(args)}`,
    );
  }
});

test("store: false 向け画像プルーニングが直近 2 枚を残し古い画像を要約へ置換する", () => {
  const makeImgResult = (id: string): AgentInputItem =>
    ({
      type: "function_call_result",
      callId: id,
      name: "drawing_render",
      status: "completed",
      output: [
        { type: "text", text: `meta:${id}` },
        { type: "image", image: { data: `BASE64_${id}`, mediaType: "image/png" } },
      ],
    }) as unknown as AgentInputItem;

  const history = [makeImgResult("1"), makeImgResult("2"), makeImgResult("3"), makeImgResult("4")];
  const pruned = pruneOldImagesFromInputItems(history, 2) as unknown as Array<{
    output: Array<{ type: string; text?: string; image?: { data: string } }>;
  }>;

  // 1, 2 は省略テキストへ置換、3, 4 は画像維持
  assert.equal(pruned[0]?.output[1]?.type, "text");
  assert.equal(pruned[1]?.output[1]?.type, "text");
  assert.equal(pruned[2]?.output[1]?.type, "image");
  assert.equal(pruned[2]?.output[1]?.image?.data, "BASE64_3");
  assert.equal(pruned[3]?.output[1]?.type, "image");
  assert.equal(pruned[3]?.output[1]?.image?.data, "BASE64_4");
});
