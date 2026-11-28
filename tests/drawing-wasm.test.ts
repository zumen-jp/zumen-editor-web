import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readScene } from "@zumen-jp/zumen";
import { parseProfileAsset, type ZumenAssetLoader } from "../src/kernel/drawing/assets";
import { DirectZumenEngineFactory } from "../src/kernel/drawing/engine";
import {
  buildSampleWorkspaceFiles,
  SAMPLE_DRAWING_PATH,
  SAMPLE_SCHEDULE_PATH,
} from "../src/kernel/drawing/sample-dxf";
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
  const memFs = new MemoryWorkspaceFs(buildSampleWorkspaceFiles());
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
    // 1. 開く・レイヤ・要素・日本語テキスト復号・対になる仕上表 CSV
    const opened = await kernel.drawings.open(SAMPLE_DRAWING_PATH);
    assert.equal(opened.format, "dxf");
    assert.equal(opened.diagnostics.filter((d) => d.severity === "error").length, 0);
    assert.ok(opened.tables.layers.some((l) => l.name === "A-WALL-EXT"));
    assert.ok(opened.tables.layers.some((l) => l.name === "A-STR-COL"));
    assert.ok(opened.tables.layers.some((l) => l.name === "A-STAIR"));
    assert.ok(opened.tables.layers.some((l) => l.name === "A-DIM"));
    assert.ok(opened.tables.layers.some((l) => l.name === "A-FRAME"));

    const ents = await kernel.drawings.entities(SAMPLE_DRAWING_PATH, { limit: 1000 });
    assert.ok(ents.total >= 200, `expected >= 200 entities, got ${ents.total}`);
    const texts = await kernel.drawings.entities(SAMPLE_DRAWING_PATH, {
      kinds: ["text"],
      limit: 200,
    });
    const textValues = texts.items.map((e) =>
      e.geometry?.shape === "text" ? e.geometry.content : "",
    );
    assert.ok(textValues.includes("1階平面図"), "日本語図面名称 TEXT が復号されていること");
    assert.ok(textValues.includes("執務室"), "日本語室名 TEXT が復号されていること");

    const equipEnts = await kernel.drawings.entities(SAMPLE_DRAWING_PATH, {
      layers: ["A-EQUIP"],
      kinds: ["circle"],
      limit: 50,
    });
    const circle = equipEnts.items.find((e) => e.kind === "circle");
    assert.ok(circle?.hash);

    const schedule = await kernel.readSpreadsheet(SAMPLE_SCHEDULE_PATH);
    assert.ok(schedule.sheets[0] && schedule.sheets[0].rows >= 20);

    // 2. シーン生成と読み取り
    const sceneBundle = await kernel.drawings.scene(SAMPLE_DRAWING_PATH, opened.defaultPlace);
    assert.ok(sceneBundle.result.counts.lines > 200);
    assert.ok(sceneBundle.result.counts.texts >= 30);
    const parsedScene = readScene(sceneBundle.blob);
    assert.ok(parsedScene.chunks > 0);

    // 3. PNG レンダリングとブラウザ標準 CompressionStream による再圧縮
    const rendered = await kernel.drawings.renderPng(SAMPLE_DRAWING_PATH, {
      width: 640,
      height: 480,
    });
    assert.equal(rendered.png[0], 0x89);
    assert.equal(rendered.png[1], 0x50);
    assert.ok(rendered.png.byteLength < 150_000);

    // 4. コア measure による実寸計測（X1-X4 全長 14,400 mm）
    const dist = await kernel.drawings.measure(SAMPLE_DRAWING_PATH, {
      quantity: "distance",
      first: { kind: "point", position: { x: 0, y: 0 } },
      second: { kind: "point", position: { x: 14400, y: 0 } },
    });
    assert.equal(dist.value, 14400);

    // 5. MLIT CAD 基準照合
    const report = await kernel.drawings.check(SAMPLE_DRAWING_PATH, "mlit-cad");
    assert.equal(report.profile.id, "mlit-cad");
    assert.ok(report.totalFindings >= 0);

    // 6. エージェント変更案（propose ではライブ文書が変わらないこと）
    const proposal = await kernel.drawings.propose(SAMPLE_DRAWING_PATH, {
      summary: "応接室の円形テーブルを X+350 移動",
      edits: [
        {
          kind: "transform",
          id: circle.id,
          hash: circle.hash,
          matrix: [1, 0, 350, 0, 1, 0],
        },
      ],
    });
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.appliedCount, 1);

    const beforeApply = await kernel.drawings.open(SAMPLE_DRAWING_PATH);
    assert.equal(beforeApply.dirty, false);
    assert.equal(beforeApply.hash, opened.hash);

    // 7. 人間による適用 -> Undo -> Redo -> 保存
    const applied = await kernel.drawings.applyProposal(SAMPLE_DRAWING_PATH, proposal.id);
    assert.equal(applied.dirty, true);
    assert.equal(applied.canUndo, true);
    assert.notEqual(applied.hash, opened.hash);

    const undone = await kernel.drawings.undo(SAMPLE_DRAWING_PATH);
    assert.equal(undone.dirty, false);
    assert.equal(undone.hash, opened.hash);

    const redone = await kernel.drawings.redo(SAMPLE_DRAWING_PATH);
    assert.equal(redone.dirty, true);
    assert.equal(redone.hash, applied.hash);

    // エージェントは action_propose の実行を拒否されること
    const saveCard = kernel.proposeAction({
      kind: "save_drawing",
      summary: `${SAMPLE_DRAWING_PATH} を保存`,
      args: { path: SAMPLE_DRAWING_PATH },
    });
    await assert.rejects(() => kernel.executeAction("agent", saveCard.id));

    // 人間だけが確認の札を実行して保存できる
    const executed = await kernel.executeAction("human", saveCard.id);
    assert.equal(executed.status, "executed");
    const afterSave = await kernel.drawings.open(SAMPLE_DRAWING_PATH, { fresh: true });
    assert.equal(afterSave.dirty, false);
    assert.equal(afterSave.hash, applied.hash);

    // 8. 確認の札: 実引数の明細・force の拒否・保存の競合は利用者だけが上書きを選べる
    assert.deepEqual(saveCard.details, [{ label: "上書き先", value: SAMPLE_DRAWING_PATH }]);
    assert.throws(
      () =>
        kernel.proposeAction({
          kind: "save_drawing",
          summary: "保存",
          args: { path: SAMPLE_DRAWING_PATH, force: true },
        }),
      /force は指定できません/,
    );

    const conflictCard = kernel.proposeAction({
      kind: "save_drawing",
      summary: "保存",
      args: { path: SAMPLE_DRAWING_PATH },
    });
    // 競合が示される前は、利用者であっても force を選べない
    await assert.rejects(
      () => kernel.executeAction("human", conflictCard.id, { force: true }),
      /競合が示された確認の札でだけ/,
    );

    // 外部アプリによる書き換えを模擬する（内容は同じでも版が変わる）
    const external = await memFs.readBytes(SAMPLE_DRAWING_PATH);
    await memFs.writeBytes(SAMPLE_DRAWING_PATH, external.bytes);

    await assert.rejects(
      () => kernel.executeAction("human", conflictCard.id),
      /外で変更されています/,
    );
    assert.equal(conflictCard.status, "pending", "競合では札を閉じず、利用者の判断を待つ");
    assert.equal(conflictCard.conflict, true);
    assert.match(conflictCard.errorMessage ?? "", /外で行われた変更は失われます/);

    await assert.rejects(() => kernel.executeAction("agent", conflictCard.id, { force: true }));
    assert.equal(conflictCard.status, "pending");

    const forced = await kernel.executeAction("human", conflictCard.id, { force: true });
    assert.equal(forced.status, "executed");
    assert.equal(forced.conflict, undefined);
    assert.equal(forced.errorMessage, undefined);
    assert.match(forced.resultMessage ?? "", /外での変更を破棄して/);
  } finally {
    await kernel.dispose();
  }
});
