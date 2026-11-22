import assert from "node:assert/strict";
import test from "node:test";
import type { AgentInputItem } from "@openai/agents";
import { pruneOldImagesFromInputItems } from "../src/kernel/agent/compaction";
import { AGENT_TOOL_NAMES } from "../src/kernel/agent/tools";
import { guardTextWriteTarget, guardWorkspacePath } from "../src/kernel/operations/guard";
import { checkOperationSymmetry } from "../src/kernel/operations/ledger";
import { ACTION_KINDS } from "../src/kernel/operations/types";

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
