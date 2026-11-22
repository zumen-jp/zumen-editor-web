import type {
  Budget,
  Diagnostic,
  DrawingResult,
  Edit,
  EntityField,
  EntityKind,
  MeasureQuantity,
  MeasureResult,
  MeasureTarget,
  TablesResult,
} from "@zumen-jp/zumen";
import { OpfsBackupStore } from "../fs/opfs-fs";
import { baseNameOf, isDrawingPath, normalizeRelativePath } from "../fs/paths";
import type { WorkspaceFs } from "../fs/types";
import { resolveProfileChain, type ZumenAssetLoader } from "./assets";
import type { ZumenEngineFactory, ZumenSessionHandle } from "./engine";
import { recompressPng } from "./png";
import {
  type CheckGroupSummary,
  type CheckProfileMeta,
  DRAWING_DECODED_BUDGET,
  type DrawingCheckReport,
  type DrawingDiagnostic,
  type DrawingHistoryItem,
  type DrawingInfo,
  type DrawingProposal,
  type DrawingSceneBundle,
  type EntityListResult,
  MAX_DRAWING_BYTES,
  type PaletteMode,
  type ProposalOverlayItem,
} from "./types";

const MAX_OPEN_DOCS = 4;
const MAX_HISTORY_ENTRIES = 40;
const CATALOG_INPUT = "zumen-editor-web/catalog.json";
const BUDGET: Budget = {
  input_bytes: MAX_DRAWING_BYTES,
  decoded_bytes: DRAWING_DECODED_BUDGET,
};

const ENTITY_FIELDS: EntityField[] = [
  "kind",
  "layer",
  "source",
  "bbox",
  "hash",
  "geometry",
  "style",
];

type HistorySnapshot = {
  item: DrawingHistoryItem;
  bytes: Uint8Array;
};

type OpenDrawingEntry = {
  path: string;
  docName: string;
  format: string;
  diskVersion: string;
  originalBytes: Uint8Array;
  currentBytes: Uint8Array;
  hash: string;
  drawing: DrawingResult;
  tables: TablesResult;
  diagnostics: DrawingDiagnostic[];
  history: HistorySnapshot[];
  cursor: number; // -1 = originalBytes, 0..history.length-1 = applied index
  proposals: DrawingProposal[];
  session: ZumenSessionHandle;
  catalogPushed: boolean;
  pushedProfiles: Set<string>;
  lastUsedAt: number;
  queue: Promise<void>;
  serial: number;
};

function safeInputName(relPath: string): string {
  const name = baseNameOf(relPath);
  return name === "" || /[:/\\]/.test(name) ? "drawing.dxf" : name;
}

function defaultPlaceOf(drawing: DrawingResult): string {
  return drawing.spaces[0]?.id ?? drawing.sheets[0]?.id ?? "space/0";
}

function paletteParam(mode: PaletteMode): string | undefined {
  if (mode === "none") return undefined;
  return "builtin:cad-v1";
}

/**
 * ブラウザ内図面文書の唯一の管理者。
 * - 人の編集・エージェントの変更案・チェック・計測・保存・Undo/Redo をすべて zumen WASM を通して管理する。
 * - エージェントは `propose` で写しへの適用検証だけを行え、適用（`applyProposal`）と保存（`save`）は人の操作専用とする。
 */
export class DrawingDocumentManager {
  private readonly docs = new Map<string, OpenDrawingEntry>();
  private readonly backups: OpfsBackupStore;
  private readonly listeners = new Set<(path: string) => void>();

  constructor(
    private readonly fs: WorkspaceFs,
    private readonly engineFactory: ZumenEngineFactory,
    private readonly assets: ZumenAssetLoader,
    backups?: OpfsBackupStore,
  ) {
    this.backups = backups ?? new OpfsBackupStore();
  }

  subscribe(listener: (path: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChange(path: string): void {
    for (const fn of this.listeners) fn(path);
  }

  private enqueue<T>(entry: OpenDrawingEntry, work: () => Promise<T>): Promise<T> {
    const next = entry.queue.then(work, work);
    entry.queue = next.then(
      () => undefined,
      () => undefined,
    );
    entry.lastUsedAt = Date.now();
    return next;
  }

  async closeAll(): Promise<void> {
    const entries = [...this.docs.values()];
    this.docs.clear();
    await Promise.all(entries.map((e) => e.session.terminate().catch(() => undefined)));
  }

  async close(rawPath: string): Promise<void> {
    const path = normalizeRelativePath(rawPath);
    const entry = this.docs.get(path);
    if (!entry) return;
    this.docs.delete(path);
    await entry.session.terminate().catch(() => undefined);
  }

  private async evictIfNeeded(keepPath: string): Promise<void> {
    while (this.docs.size >= MAX_OPEN_DOCS) {
      let victim: OpenDrawingEntry | null = null;
      for (const entry of this.docs.values()) {
        if (entry.path === keepPath) continue;
        if (this.isDirty(entry)) continue;
        if (!victim || entry.lastUsedAt < victim.lastUsedAt) {
          victim = entry;
        }
      }
      if (!victim) break;
      this.docs.delete(victim.path);
      await victim.session.terminate().catch(() => undefined);
    }
  }

  private isDirty(entry: OpenDrawingEntry): boolean {
    return entry.cursor >= 0;
  }

  private async describeDiagnostics(
    entry: OpenDrawingEntry,
    stage: DrawingDiagnostic["stage"],
    diagnostics: readonly Diagnostic[],
  ): Promise<DrawingDiagnostic[]> {
    if (diagnostics.length === 0) return [];
    let texts: string[] = [];
    try {
      if (!entry.catalogPushed) {
        const catalogBytes = await this.assets.loadCatalogBytes();
        if (catalogBytes) {
          await entry.session.push(CATALOG_INPUT, catalogBytes);
          entry.catalogPushed = true;
        }
      }
      const res = await entry.session.call({
        v: 1,
        op: "describe",
        ...(entry.catalogPushed ? { catalog: CATALOG_INPUT } : {}),
        diagnostics: [...diagnostics],
      });
      texts = res.response.result.texts;
    } catch {
      texts = diagnostics.map((d) => d.code);
    }
    return diagnostics.map((d, idx) => ({
      stage,
      code: d.code,
      severity: d.severity,
      count: d.count ?? 1,
      text: texts[idx] ?? d.code,
    }));
  }

  private toDrawingInfo(entry: OpenDrawingEntry): DrawingInfo {
    const appliedHistory = entry.history.slice(0, entry.cursor + 1).map((h) => h.item);
    return {
      path: entry.path,
      version: `${entry.diskVersion}:${entry.hash}`,
      format: entry.format,
      hash: entry.hash,
      dirty: this.isDirty(entry),
      canUndo: entry.cursor >= 0,
      canRedo: entry.cursor + 1 < entry.history.length,
      drawing: entry.drawing,
      tables: entry.tables,
      diagnostics: entry.diagnostics,
      history: appliedHistory,
      proposals: [...entry.proposals],
      defaultPlace: defaultPlaceOf(entry.drawing),
    };
  }

  private async reloadEntrySession(
    entry: OpenDrawingEntry,
    bytes: Uint8Array,
    stage: "open" | "apply",
  ): Promise<void> {
    const seq = ++entry.serial;
    const input = `${safeInputName(entry.path)}#${seq}`;
    const docName = `doc_${seq}`;
    await entry.session.push(input, bytes);
    const opened = await entry.session.call({
      v: 1,
      op: "open",
      input,
      doc: docName,
      budget: BUDGET,
    });
    const drawing = await entry.session.call({
      v: 1,
      op: "drawing",
      doc: docName,
      budget: BUDGET,
    });
    const tables = await entry.session.call({
      v: 1,
      op: "tables",
      doc: docName,
      budget: BUDGET,
    });
    const diags = [
      ...(await this.describeDiagnostics(entry, stage, opened.response.diagnostics ?? [])),
      ...(await this.describeDiagnostics(entry, "drawing", drawing.response.diagnostics ?? [])),
    ];
    entry.docName = docName;
    entry.format = opened.response.result.format;
    entry.currentBytes = bytes;
    entry.hash = drawing.response.result.hash ?? `${bytes.byteLength}`;
    entry.drawing = drawing.response.result;
    entry.tables = tables.response.result;
    entry.diagnostics = diags;
  }

  async open(rawPath: string, options?: { fresh?: boolean }): Promise<DrawingInfo> {
    const path = normalizeRelativePath(rawPath);
    if (!isDrawingPath(path)) {
      throw new Error(`図面ファイルではありません: ${path}`);
    }

    const existing = this.docs.get(path);
    if (existing && !options?.fresh && !existing.session.stopped) {
      if (!this.isDirty(existing)) {
        const stat = await this.fs.stat(path);
        if (stat.version === existing.diskVersion) {
          existing.lastUsedAt = Date.now();
          return this.toDrawingInfo(existing);
        }
      } else {
        existing.lastUsedAt = Date.now();
        return this.toDrawingInfo(existing);
      }
    }

    if (existing) {
      this.docs.delete(path);
      await existing.session.terminate().catch(() => undefined);
    }

    await this.evictIfNeeded(path);
    const { bytes, stat } = await this.fs.readBytes(path);
    if (bytes.byteLength > MAX_DRAWING_BYTES) {
      throw new Error(
        `図面ファイルが大きすぎます（上限 ${MAX_DRAWING_BYTES / (1024 * 1024)} MiB）。`,
      );
    }

    const session = await this.engineFactory.createSession();
    const entry: OpenDrawingEntry = {
      path,
      docName: "doc_0",
      format: "",
      diskVersion: stat.version,
      originalBytes: new Uint8Array(bytes),
      currentBytes: new Uint8Array(bytes),
      hash: "",
      drawing: { spaces: [], sheets: [] },
      tables: { layers: [], line_types: [], text_styles: [], dimension_styles: [], symbols: [] },
      diagnostics: [],
      history: [],
      cursor: -1,
      proposals: [],
      session,
      catalogPushed: false,
      pushedProfiles: new Set(),
      lastUsedAt: Date.now(),
      queue: Promise.resolve(),
      serial: 0,
    };

    try {
      await this.reloadEntrySession(entry, entry.currentBytes, "open");
      this.docs.set(path, entry);
      this.emitChange(path);
      return this.toDrawingInfo(entry);
    } catch (error) {
      await session.terminate().catch(() => undefined);
      throw error;
    }
  }

  private async requireOpen(rawPath: string): Promise<OpenDrawingEntry> {
    const path = normalizeRelativePath(rawPath);
    const existing = this.docs.get(path);
    if (existing && !existing.session.stopped) return existing;
    await this.open(path);
    const loaded = this.docs.get(path);
    if (!loaded) throw new Error(`図面を開けませんでした: ${path}`);
    return loaded;
  }

  async scene(
    rawPath: string,
    place?: string,
    options?: { palette?: PaletteMode; print?: boolean },
  ): Promise<DrawingSceneBundle> {
    const entry = await this.requireOpen(rawPath);
    return this.enqueue(entry, async () => {
      const from = place || defaultPlaceOf(entry.drawing);
      const pal = paletteParam(options?.palette ?? "builtin");
      const res = await entry.session.call(
        {
          v: 1,
          op: "scene",
          doc: entry.docName,
          from,
          ...(pal ? { palette: pal } : {}),
          ...(options?.print ? { print: true } : {}),
          budget: BUDGET,
        },
        { take: true },
      );
      const blob = res.blobs[0];
      if (!blob) throw new Error("シーンのバイナリを取得できませんでした。");
      const diags = await this.describeDiagnostics(entry, "scene", res.response.diagnostics ?? []);
      return {
        path: entry.path,
        version: `${entry.diskVersion}:${entry.hash}`,
        doc: entry.docName,
        format: entry.format,
        hash: entry.hash,
        place: from,
        result: res.response.result,
        blob,
        diagnostics: diags,
      };
    });
  }

  async entities(
    rawPath: string,
    query?: {
      place?: string;
      ids?: string[];
      layers?: string[];
      kinds?: EntityKind[];
      region?: [number, number, number, number];
      offset?: number;
      limit?: number;
    },
  ): Promise<EntityListResult> {
    const entry = await this.requireOpen(rawPath);
    return this.enqueue(entry, async () => {
      const res = await entry.session.call({
        v: 1,
        op: "entities",
        doc: entry.docName,
        fields: ENTITY_FIELDS,
        ...(query?.place ? { place: query.place } : {}),
        ...(query?.ids ? { ids: query.ids } : {}),
        ...(query?.layers ? { layers: query.layers } : {}),
        ...(query?.kinds ? { kinds: query.kinds } : {}),
        ...(query?.region ? { region: query.region } : {}),
        offset: query?.offset ?? 0,
        limit: Math.max(1, Math.min(200, query?.limit ?? 50)),
        budget: BUDGET,
      });
      return {
        items: res.response.result.items,
        total: res.response.result.total,
        ...(res.response.result.next_offset !== undefined
          ? { nextOffset: res.response.result.next_offset }
          : {}),
      };
    });
  }

  async renderPng(
    rawPath: string,
    options?: {
      place?: string;
      region?: [number, number, number, number];
      width?: number;
      height?: number;
      hiddenLayers?: string[];
      palette?: PaletteMode;
    },
  ): Promise<{
    png: Uint8Array;
    width: number;
    height: number;
    region: [number, number, number, number];
    diagnostics: DrawingDiagnostic[];
  }> {
    const entry = await this.requireOpen(rawPath);
    return this.enqueue(entry, async () => {
      const from = options?.place || defaultPlaceOf(entry.drawing);
      const pal = paletteParam(options?.palette ?? "builtin");
      let region = options?.region;
      if (!region) {
        const sc = await entry.session.call({
          v: 1,
          op: "scene",
          doc: entry.docName,
          from,
          ...(pal ? { palette: pal } : {}),
          budget: BUDGET,
        });
        const ext = sc.response.result.extent;
        if (ext && ext.max_x > ext.min_x && ext.max_y > ext.min_y) {
          const padX = (ext.max_x - ext.min_x) * 0.05;
          const padY = (ext.max_y - ext.min_y) * 0.05;
          region = [ext.min_x - padX, ext.min_y - padY, ext.max_x + padX, ext.max_y + padY];
        } else {
          region = [0, 0, 1000, 1000];
        }
      }
      const width = Math.max(128, Math.min(2048, options?.width ?? 1024));
      const height = Math.max(128, Math.min(2048, options?.height ?? 768));

      const rendered = await entry.session.call(
        {
          v: 1,
          op: "render",
          doc: entry.docName,
          from,
          format: "png",
          width,
          height,
          region,
          dpi: 96,
          background: [255, 255, 255, 255],
          foreground: [17, 17, 17, 255],
          ...(pal ? { palette: pal } : {}),
          ...(options?.hiddenLayers?.length ? { hidden_layers: options.hiddenLayers } : {}),
          budget: BUDGET,
        },
        { take: true },
      );
      const rawPng = rendered.blobs[0];
      if (!rawPng) throw new Error("PNG 画像を生成できませんでした。");
      const png = await recompressPng(rawPng);
      const diagnostics = await this.describeDiagnostics(
        entry,
        "render",
        rendered.response.diagnostics ?? [],
      );
      return { png, width, height, region, diagnostics };
    });
  }

  async listCheckProfiles(): Promise<CheckProfileMeta[]> {
    const all = await this.assets.listProfiles();
    return all.map((p) => p.meta);
  }

  async check(
    rawPath: string,
    profileId = "mlit-cad",
    edition?: string,
  ): Promise<DrawingCheckReport> {
    const entry = await this.requireOpen(rawPath);
    return this.enqueue(entry, async () => {
      const allProfiles = await this.assets.listProfiles();
      const chain = resolveProfileChain(allProfiles, profileId, edition);
      if (chain.length === 0) {
        throw new Error(`照合プロファイルが見つかりません: ${profileId}`);
      }
      for (const p of chain) {
        if (!entry.pushedProfiles.has(p.inputName)) {
          await entry.session.push(p.inputName, p.bytes);
          entry.pushedProfiles.add(p.inputName);
        }
      }
      const target = chain[chain.length - 1]!;
      const res = await entry.session.call({
        v: 1,
        op: "check",
        doc: entry.docName,
        profiles: chain.map((p) => p.inputName),
        profile: { id: target.meta.id, edition: target.meta.edition },
        file_name: baseNameOf(entry.path),
        palette: "builtin:cad-v1",
        limit: 1000,
        budget: BUDGET,
      });

      const findings = res.response.result.findings;
      const ruleCheckById = new Map(res.response.result.rules.map((r) => [r.id, r.check]));
      const describedFindings = await this.describeDiagnostics(
        entry,
        "check",
        findings.map((f) => f.diagnostic),
      );
      const groupsMap = new Map<string, CheckGroupSummary>();
      let unresolvedCount = 0;

      for (let i = 0; i < findings.length; i++) {
        const f = findings[i]!;
        const diag = f.diagnostic;
        const text = describedFindings[i]?.text ?? diag.code;
        if (diag.severity === "info") {
          unresolvedCount += 1;
          continue;
        }
        const checkKind = ruleCheckById.get(f.rule) ?? diag.code;
        const key = `${f.rule}:${diag.severity}`;
        let group = groupsMap.get(key);
        if (!group) {
          group = {
            ruleId: f.rule,
            check: checkKind,
            severity: diag.severity,
            count: 0,
            sampleElements: [],
            sampleMessages: [],
          };
          groupsMap.set(key, group);
        }
        group.count += 1;
        for (const place of diag.at ?? []) {
          const elId = place.id;
          if (elId && group.sampleElements.length < 20 && !group.sampleElements.includes(elId)) {
            group.sampleElements.push(elId);
          }
        }
        if (group.sampleMessages.length < 5 && !group.sampleMessages.includes(text)) {
          group.sampleMessages.push(text);
        }
      }

      const diagnostics = await this.describeDiagnostics(
        entry,
        "check",
        res.response.diagnostics ?? [],
      );

      return {
        path: entry.path,
        profile: target.meta,
        totalFindings: res.response.result.total,
        unresolvedCount,
        groups: [...groupsMap.values()],
        diagnostics,
      };
    });
  }

  async measure(
    rawPath: string,
    params: {
      from?: string;
      quantity: MeasureQuantity;
      first: MeasureTarget;
      second?: MeasureTarget;
    },
  ): Promise<MeasureResult> {
    const entry = await this.requireOpen(rawPath);
    return this.enqueue(entry, async () => {
      const res = await entry.session.call({
        v: 1,
        op: "measure",
        doc: entry.docName,
        from: params.from || defaultPlaceOf(entry.drawing),
        quantity: params.quantity,
        first: params.first,
        ...(params.second ? { second: params.second } : {}),
        expected_hash: entry.hash,
        budget: BUDGET,
      });
      return res.response.result;
    });
  }

  /**
   * エージェント用の変更案検証。ライブ文書は変更せず、独立した写しで `apply` を試す。
   */
  async propose(
    rawPath: string,
    params: { edits: Edit[]; summary: string; replaces?: string[] },
  ): Promise<DrawingProposal> {
    if (params.edits.length === 0) {
      throw new Error("変更の一覧が空です。");
    }
    const entry = await this.requireOpen(rawPath);
    return this.enqueue(entry, async () => {
      // 対象要素の現在 bbox を重ね描き用に取得
      const targetIds = params.edits
        .map((e) => ("id" in e && typeof e.id === "string" ? e.id : null))
        .filter((id): id is string => id !== null);
      const bboxById = new Map<
        string,
        { min_x: number; min_y: number; max_x: number; max_y: number }
      >();
      if (targetIds.length > 0) {
        try {
          const ents = await entry.session.call({
            v: 1,
            op: "entities",
            doc: entry.docName,
            ids: targetIds.slice(0, 200),
            fields: ["bbox"],
            limit: 200,
            budget: BUDGET,
          });
          for (const item of ents.response.result.items) {
            if (item.bbox) bboxById.set(item.id, item.bbox);
          }
        } catch {
          // bbox 取得失敗時はスキップ
        }
      }

      // 独立した写し文書で dry-run 適用する（ライブ文書は一切触らない）。
      const probeSeq = ++entry.serial;
      const probeInput = `${safeInputName(entry.path)}#proposal_${probeSeq}`;
      const probeDoc = `proposal_${probeSeq}`;
      await entry.session.push(probeInput, entry.currentBytes);
      await entry.session.call({
        v: 1,
        op: "open",
        input: probeInput,
        doc: probeDoc,
        budget: BUDGET,
      });

      const applied = await entry.session.call({
        v: 1,
        op: "apply",
        doc: probeDoc,
        hash: entry.hash,
        edits: params.edits,
        budget: BUDGET,
      });

      const diagnostics = await this.describeDiagnostics(
        entry,
        "apply",
        applied.response.diagnostics ?? [],
      );

      // replaces で指定された過去の pending 案を取り下げ扱いにする。
      if (params.replaces?.length) {
        const replaceSet = new Set(params.replaces);
        for (const p of entry.proposals) {
          if (replaceSet.has(p.id) && p.status === "pending") {
            p.status = "superseded";
          }
        }
      }

      const overlays: ProposalOverlayItem[] = params.edits.map((edit) => {
        const id = "id" in edit && typeof edit.id === "string" ? edit.id : undefined;
        return {
          kind: edit.kind,
          ...(id ? { id, bbox: bboxById.get(id) } : {}),
        };
      });

      const proposal: DrawingProposal = {
        id: crypto.randomUUID(),
        path: entry.path,
        baseHash: entry.hash,
        summary: params.summary,
        edits: params.edits,
        status: "pending",
        createdAt: Date.now(),
        appliedCount: applied.response.result.applied.length,
        diagnostics,
        overlays,
      };
      entry.proposals.push(proposal);
      this.emitChange(entry.path);
      return proposal;
    });
  }

  /** 人間専用: 変更案を図面へ適用する。 */
  async applyProposal(rawPath: string, proposalId: string): Promise<DrawingInfo> {
    const entry = await this.requireOpen(rawPath);
    return this.enqueue(entry, async () => {
      const proposal = entry.proposals.find((p) => p.id === proposalId);
      if (!proposal) throw new Error("指定された変更案が見つかりません。");
      if (proposal.status !== "pending") {
        throw new Error(`この変更案はすでに処理済みです（${proposal.status}）。`);
      }
      if (proposal.baseHash !== entry.hash) {
        proposal.status = "stale";
        this.emitChange(entry.path);
        throw new Error(
          "図面が変更されたため、この変更案は古くなりました（change.element.stale）。エージェントに読み直して作り直してもらってください。",
        );
      }

      await this.commitEditsLocked(entry, proposal.edits, proposal.summary, {
        kind: "agent",
        proposalId: proposal.id,
      });
      proposal.status = "applied";
      for (const other of entry.proposals) {
        if (other.id !== proposal.id && other.status === "pending") {
          other.status = "stale";
        }
      }
      this.emitChange(entry.path);
      return this.toDrawingInfo(entry);
    });
  }

  /** 人間専用: 変更案を退ける。 */
  async dismissProposal(
    rawPath: string,
    proposalId: string,
    reason?: string,
  ): Promise<DrawingInfo> {
    const entry = await this.requireOpen(rawPath);
    return this.enqueue(entry, async () => {
      const proposal = entry.proposals.find((p) => p.id === proposalId);
      if (!proposal) throw new Error("指定された変更案が見つかりません。");
      if (proposal.status === "pending") {
        proposal.status = "dismissed";
        if (reason) proposal.dismissReason = reason;
        this.emitChange(entry.path);
      }
      return this.toDrawingInfo(entry);
    });
  }

  /** 人間専用: UI 操作からの直接編集を適用する。 */
  async applyUserEdits(rawPath: string, edits: Edit[], summary: string): Promise<DrawingInfo> {
    const entry = await this.requireOpen(rawPath);
    return this.enqueue(entry, async () => {
      await this.commitEditsLocked(entry, edits, summary, { kind: "user" });
      for (const p of entry.proposals) {
        if (p.status === "pending") p.status = "stale";
      }
      this.emitChange(entry.path);
      return this.toDrawingInfo(entry);
    });
  }

  private async commitEditsLocked(
    entry: OpenDrawingEntry,
    edits: Edit[],
    summary: string,
    author: DrawingHistoryItem["author"],
  ): Promise<void> {
    const applied = await entry.session.call(
      {
        v: 1,
        op: "apply",
        doc: entry.docName,
        hash: entry.hash,
        edits,
        budget: BUDGET,
      },
      { take: true },
    );
    const nextBytes = applied.blobs[0];
    if (!nextBytes) throw new Error("書き戻した図面バイト列を取得できませんでした。");

    const applyDiags = await this.describeDiagnostics(
      entry,
      "apply",
      applied.response.diagnostics ?? [],
    );
    await this.reloadEntrySession(entry, nextBytes, "apply");

    // Redo 枝を切り捨てて履歴に追加
    entry.history = entry.history.slice(0, entry.cursor + 1);
    entry.history.push({
      item: {
        id: crypto.randomUUID(),
        author,
        summary,
        editCount: edits.length,
        createdAt: Date.now(),
        idsShifted: applied.response.result.ids_shifted === true,
        diagnostics: applyDiags,
      },
      bytes: nextBytes,
    });
    if (entry.history.length > MAX_HISTORY_ENTRIES) {
      const overflow = entry.history.length - MAX_HISTORY_ENTRIES;
      entry.history = entry.history.slice(overflow);
    }
    entry.cursor = entry.history.length - 1;
  }

  async undo(rawPath: string): Promise<DrawingInfo> {
    const entry = await this.requireOpen(rawPath);
    return this.enqueue(entry, async () => {
      if (entry.cursor < 0) return this.toDrawingInfo(entry);
      entry.cursor -= 1;
      const bytes = entry.cursor >= 0 ? entry.history[entry.cursor]!.bytes : entry.originalBytes;
      await this.reloadEntrySession(entry, bytes, "open");
      this.emitChange(entry.path);
      return this.toDrawingInfo(entry);
    });
  }

  async redo(rawPath: string): Promise<DrawingInfo> {
    const entry = await this.requireOpen(rawPath);
    return this.enqueue(entry, async () => {
      if (entry.cursor + 1 >= entry.history.length) return this.toDrawingInfo(entry);
      entry.cursor += 1;
      const bytes = entry.history[entry.cursor]!.bytes;
      await this.reloadEntrySession(entry, bytes, "open");
      this.emitChange(entry.path);
      return this.toDrawingInfo(entry);
    });
  }

  /** 人間専用: 現在の図面バイト列を元のファイルへ上書き保存する（直前ファイルを OPFS へ控え保存）。 */
  async save(rawPath: string, options?: { force?: boolean }): Promise<DrawingInfo> {
    const entry = await this.requireOpen(rawPath);
    return this.enqueue(entry, async () => {
      const { bytes: diskBytes } = await this.fs.readBytes(entry.path);
      await this.backups.saveBackup(this.fs.id, entry.path, diskBytes);

      const stat = await this.fs.writeBytes(entry.path, entry.currentBytes, {
        ...(options?.force ? {} : { expectedVersion: entry.diskVersion }),
      });
      entry.diskVersion = stat.version;
      entry.originalBytes = new Uint8Array(entry.currentBytes);
      entry.history = [];
      entry.cursor = -1;
      this.emitChange(entry.path);
      return this.toDrawingInfo(entry);
    });
  }

  /** 人間専用: DXF / SVG / PNG 形式で別ファイルへ書き出す。 */
  async exportDrawing(
    rawPath: string,
    targetRawPath: string,
    format: "dxf" | "svg" | "png",
  ): Promise<{ targetPath: string; bytes: number }> {
    const entry = await this.requireOpen(rawPath);
    const targetPath = normalizeRelativePath(targetRawPath);
    return this.enqueue(entry, async () => {
      let outBytes: Uint8Array;
      if (format === "dxf") {
        const res = await entry.session.call(
          {
            v: 1,
            op: "convert",
            doc: entry.docName,
            format: "dxf",
            to: `export_${++entry.serial}`,
            budget: BUDGET,
          },
          { take: true },
        );
        const blob = res.blobs[0];
        if (!blob) throw new Error("DXF 変換の出力を取得できませんでした。");
        outBytes = blob;
      } else {
        const from = defaultPlaceOf(entry.drawing);
        const sc = await entry.session.call({
          v: 1,
          op: "scene",
          doc: entry.docName,
          from,
          palette: "builtin:cad-v1",
          budget: BUDGET,
        });
        const ext = sc.response.result.extent;
        const region =
          ext && ext.max_x > ext.min_x && ext.max_y > ext.min_y
            ? [ext.min_x, ext.min_y, ext.max_x, ext.max_y]
            : [0, 0, 1000, 1000];
        const res = await entry.session.call(
          {
            v: 1,
            op: "render",
            doc: entry.docName,
            from,
            format,
            width: 1600,
            height: 1200,
            region,
            dpi: 96,
            background: [255, 255, 255, 255],
            foreground: [17, 17, 17, 255],
            palette: "builtin:cad-v1",
            budget: BUDGET,
          },
          { take: true },
        );
        const blob = res.blobs[0];
        if (!blob) throw new Error(`${format.toUpperCase()} 書き出しに失敗しました。`);
        outBytes = format === "png" ? await recompressPng(blob) : blob;
      }
      await this.fs.writeBytes(targetPath, outBytes, { create: true });
      return { targetPath, bytes: outBytes.byteLength };
    });
  }

  /** 人間専用: 新規の空 DXF を作成して保存する。 */
  async createNewDxf(
    targetRawPath: string,
    unit: "millimeter" | "meter" = "millimeter",
  ): Promise<string> {
    const targetPath = normalizeRelativePath(targetRawPath);
    const session = await this.engineFactory.createSession();
    try {
      const res = await session.call(
        {
          v: 1,
          op: "create",
          format: "dxf",
          to: "new_dxf",
          unit,
          budget: BUDGET,
        },
        { take: true },
      );
      const blob = res.blobs[0];
      if (!blob) throw new Error("新規 DXF を作成できませんでした。");
      await this.fs.writeBytes(targetPath, blob, { create: true });
      return targetPath;
    } finally {
      await session.terminate().catch(() => undefined);
    }
  }

  async historyInfo(rawPath: string): Promise<{
    path: string;
    dirty: boolean;
    hash: string;
    history: DrawingHistoryItem[];
    proposals: DrawingProposal[];
  }> {
    const entry = await this.requireOpen(rawPath);
    return {
      path: entry.path,
      dirty: this.isDirty(entry),
      hash: entry.hash,
      history: entry.history.slice(0, entry.cursor + 1).map((h) => h.item),
      proposals: [...entry.proposals],
    };
  }
}
