import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readScene } from "@zumen-jp/zumen";
import { parseProfileAsset, type ZumenAssetLoader } from "../src/kernel/drawing/assets";
import { DirectZumenEngineFactory } from "../src/kernel/drawing/engine";
import { buildSamplePlanDxf } from "../src/kernel/drawing/sample-dxf";
import { MemoryWorkspaceFs } from "../src/kernel/fs/opfs-fs";
import { BrowserKernel } from "../src/kernel/operations/kernel";

const ROOT = path.resolve(import.meta.dirname, "..");

function createTestAssetLoader(): ZumenAssetLoader {
  return {
    async loadCatalogBytes() {
      const buf = await fs.readFile(path.join(ROOT, "public/assets/zumen/catalog/ja.json"));
      return new Uint8Array(buf);
    },
    async listProfiles() {
      const slug = "mlit-cad/2025-12";
      const buf = await fs.readFile(
        path.join(ROOT, "public/assets/zumen/profiles", slug, "profile.json"),
      );
      const parsed = parseProfileAsset(slug, new Uint8Array(buf));
      return parsed ? [parsed] : [];
    },
  };
}

test("実 zumen WASM で図面の開閉・シーン・PNG圧縮・計測・照合・変更案適用・Undo/Redo・保存が通る", async () => {
  const memFs = new MemoryWorkspaceFs({
    "sample-plan.dxf": buildSamplePlanDxf(),
  });
  const engineFactory = new DirectZumenEngineFactory(async () => {
    const buf = await fs.readFile(
      path.join(ROOT, "node_modules/@zumen-jp/zumen/zumen_abi1_drawing.wasm"),
    );
    return new Uint8Array(buf);
  });

  const kernel = new BrowserKernel({
    fs: memFs,
    engineFactory,
    assets: createTestAssetLoader(),
  });

  try {
    // 1. 開く・レイヤ・要素
    const opened = await kernel.drawings.open("sample-plan.dxf");
    assert.equal(opened.format, "dxf");
    assert.ok(opened.tables.layers.some((l) => l.name === "A-WALL"));

    const ents = await kernel.drawings.entities("sample-plan.dxf", { limit: 100 });
    assert.equal(ents.total, 14);
    const circle = ents.items.find((e) => e.kind === "circle");
    assert.ok(circle?.hash);

    // 2. シーン生成と読み取り
    const sceneBundle = await kernel.drawings.scene("sample-plan.dxf", opened.defaultPlace);
    assert.ok(sceneBundle.result.counts.lines > 0);
    const parsedScene = readScene(sceneBundle.blob);
    assert.ok(parsedScene.chunks > 0);

    // 3. PNG レンダリングとブラウザ標準 CompressionStream による再圧縮
    const rendered = await kernel.drawings.renderPng("sample-plan.dxf", {
      width: 512,
      height: 384,
    });
    assert.equal(rendered.png[0], 0x89);
    assert.equal(rendered.png[1], 0x50);
    assert.ok(rendered.png.byteLength < 100_000);

    // 4. コア measure による実寸計測
    const dist = await kernel.drawings.measure("sample-plan.dxf", {
      quantity: "distance",
      first: { kind: "point", position: { x: 0, y: 0 } },
      second: { kind: "point", position: { x: 6000, y: 0 } },
    });
    assert.equal(dist.value, 6000);

    // 5. MLIT CAD 基準照合
    const report = await kernel.drawings.check("sample-plan.dxf", "mlit-cad");
    assert.equal(report.profile.id, "mlit-cad");
    assert.ok(report.totalFindings >= 0);

    // 6. エージェント変更案（propose ではライブ文書が変わらないこと）
    const proposal = await kernel.drawings.propose("sample-plan.dxf", {
      summary: "中央の円を X+500 移動",
      edits: [
        {
          kind: "transform",
          id: circle.id,
          hash: circle.hash,
          matrix: [1, 0, 500, 0, 1, 0],
        },
      ],
    });
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.appliedCount, 1);

    const beforeApply = await kernel.drawings.open("sample-plan.dxf");
    assert.equal(beforeApply.dirty, false);
    assert.equal(beforeApply.hash, opened.hash);

    // 7. 人間による適用 -> Undo -> Redo -> 保存
    const applied = await kernel.drawings.applyProposal("sample-plan.dxf", proposal.id);
    assert.equal(applied.dirty, true);
    assert.equal(applied.canUndo, true);
    assert.notEqual(applied.hash, opened.hash);

    const undone = await kernel.drawings.undo("sample-plan.dxf");
    assert.equal(undone.dirty, false);
    assert.equal(undone.hash, opened.hash);

    const redone = await kernel.drawings.redo("sample-plan.dxf");
    assert.equal(redone.dirty, true);
    assert.equal(redone.hash, applied.hash);

    // エージェントは action_propose の実行を拒否されること
    const saveCard = kernel.proposeAction({
      kind: "save_drawing",
      summary: "sample-plan.dxf を保存",
      args: { path: "sample-plan.dxf" },
    });
    await assert.rejects(() => kernel.executeAction("agent", saveCard.id));

    // 人間だけが確認の札を実行して保存できる
    const executed = await kernel.executeAction("human", saveCard.id);
    assert.equal(executed.status, "executed");
    const afterSave = await kernel.drawings.open("sample-plan.dxf", { fresh: true });
    assert.equal(afterSave.dirty, false);
    assert.equal(afterSave.hash, applied.hash);
  } finally {
    await kernel.dispose();
  }
});
