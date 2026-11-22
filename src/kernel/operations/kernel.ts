import type { ZumenAssetLoader } from "../drawing/assets";
import type { ZumenEngineFactory } from "../drawing/engine";
import { DrawingDocumentManager } from "../drawing/manager";
import type { ViewCommand, WorkspaceViewState } from "../drawing/types";
import { OpfsBackupStore } from "../fs/opfs-fs";
import { extensionOf, isProtectedDrawingOrBimPath } from "../fs/paths";
import { searchWorkspaceText } from "../fs/search";
import type { Eol, TextEncoding, TextFormat } from "../fs/text-codec";
import type { TextChangeRecord, WorkspaceFs } from "../fs/types";
import { parseSpreadsheetBytes } from "../sheet/reader";
import { getTextChangeRecord, saveTextChangeRecord } from "../storage/idb";
import { guardTextWriteTarget, guardWorkspacePath } from "./guard";
import {
  ACTION_LABELS,
  type ActionKind,
  type ActionProposal,
  type Actor,
  OperationError,
} from "./types";

export interface ViewBridge {
  getViewState(): WorkspaceViewState;
  dispatchViewCommand(command: ViewCommand): void;
  isTextDirty(path: string): boolean;
  notifyFileChanged(path: string): void;
}

const DEFAULT_VIEW_BRIDGE: ViewBridge = {
  getViewState: () => ({ activePath: null, openTabs: [] }),
  dispatchViewCommand: () => undefined,
  isTextDirty: () => false,
  notifyFileChanged: () => undefined,
};

/**
 * ブラウザ内で動作する zumen-editor-web の中核カーネル。
 * UI 操作とエージェントツールの双方がこのインスタンスを経由し、同じ文書・同じ権限規則を共有する。
 */
export class BrowserKernel {
  readonly fs: WorkspaceFs;
  readonly drawings: DrawingDocumentManager;
  readonly backups: OpfsBackupStore;
  private viewBridge: ViewBridge;
  private readonly actions = new Map<string, ActionProposal>();
  private readonly textChanges = new Map<string, TextChangeRecord>();
  private readonly actionListeners = new Set<() => void>();

  constructor(params: {
    fs: WorkspaceFs;
    engineFactory: ZumenEngineFactory;
    assets: ZumenAssetLoader;
    viewBridge?: ViewBridge;
  }) {
    this.fs = params.fs;
    this.backups = new OpfsBackupStore();
    this.drawings = new DrawingDocumentManager(
      params.fs,
      params.engineFactory,
      params.assets,
      this.backups,
    );
    this.viewBridge = params.viewBridge ?? DEFAULT_VIEW_BRIDGE;
  }

  setViewBridge(bridge: ViewBridge): void {
    this.viewBridge = bridge;
  }

  getViewState(): WorkspaceViewState {
    return this.viewBridge.getViewState();
  }

  dispatchViewCommand(command: ViewCommand): void {
    this.viewBridge.dispatchViewCommand(command);
  }

  subscribeActions(listener: () => void): () => void {
    this.actionListeners.add(listener);
    return () => this.actionListeners.delete(listener);
  }

  private emitActions(): void {
    for (const fn of this.actionListeners) fn();
  }

  listActions(): ActionProposal[] {
    return [...this.actions.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getAction(id: string): ActionProposal | undefined {
    return this.actions.get(id);
  }

  /** エージェント用: 境界操作（commit 分類）の確認の札を発行する。実行は行わない。 */
  proposeAction(params: {
    kind: ActionKind;
    summary: string;
    args: Record<string, unknown>;
  }): ActionProposal {
    const proposal: ActionProposal = {
      id: crypto.randomUUID(),
      kind: params.kind,
      title: ACTION_LABELS[params.kind],
      summary: params.summary,
      params: params.args,
      status: "pending",
      createdAt: Date.now(),
    };
    this.actions.set(proposal.id, proposal);
    this.emitActions();
    return proposal;
  }

  /** 人間専用: 確認の札を実行する。 */
  async executeAction(actor: Actor, id: string): Promise<ActionProposal> {
    if (actor !== "human") {
      throw new OperationError("forbidden", "確認の札を実行できるのは利用者だけです。");
    }
    const action = this.actions.get(id);
    if (!action) throw new OperationError("not_found", "確認の札が見つかりません。");
    if (action.status !== "pending") {
      throw new OperationError("conflict", "この確認の札はすでに処理済みです。");
    }

    try {
      const p = action.params;
      let resultMessage = "実行しました。";
      switch (action.kind) {
        case "create_drawing": {
          const target = guardWorkspacePath(String(p.path ?? ""));
          const unit = p.unit === "meter" ? "meter" : "millimeter";
          await this.drawings.createNewDxf(target, unit);
          this.viewBridge.notifyFileChanged(target);
          this.viewBridge.dispatchViewCommand({ type: "open", path: target });
          resultMessage = `新規 DXF「${target}」を作成しました。`;
          break;
        }
        case "save_drawing": {
          const target = guardWorkspacePath(String(p.path ?? ""));
          await this.drawings.save(target, { force: p.force === true });
          this.viewBridge.notifyFileChanged(target);
          resultMessage = `図面「${target}」を上書き保存しました（直前ファイルを OPFS に控え保存）。`;
          break;
        }
        case "export_drawing": {
          const source = guardWorkspacePath(String(p.path ?? ""));
          const target = guardWorkspacePath(String(p.targetPath ?? ""));
          const format = p.format === "svg" || p.format === "png" ? p.format : ("dxf" as const);
          const out = await this.drawings.exportDrawing(source, target, format);
          this.viewBridge.notifyFileChanged(out.targetPath);
          resultMessage = `「${out.targetPath}」（${out.bytes.toLocaleString()} B）へ書き出しました。`;
          break;
        }
        case "create_folder": {
          const dir = guardWorkspacePath(String(p.path ?? ""));
          await this.fs.mkdir(dir);
          this.viewBridge.notifyFileChanged(dir);
          resultMessage = `フォルダー「${dir}」を作成しました。`;
          break;
        }
        case "rename_entry": {
          const from = guardWorkspacePath(String(p.path ?? ""));
          const to = guardWorkspacePath(String(p.to ?? ""));
          await this.fs.renameEntry(from, to);
          this.viewBridge.notifyFileChanged(to);
          resultMessage = `「${from}」を「${to}」へ変更しました。`;
          break;
        }
        case "delete_entry": {
          const target = guardWorkspacePath(String(p.path ?? ""));
          const stat = await this.fs.stat(target);
          if (stat.kind === "file") {
            const { bytes } = await this.fs.readBytes(target);
            await this.backups.saveBackup(this.fs.id, target, bytes);
          }
          await this.fs.deleteEntry(target);
          this.viewBridge.notifyFileChanged(target);
          resultMessage = `「${target}」を削除しました（ファイルは OPFS に控えを保存）。`;
          break;
        }
        case "convert_encoding": {
          const target = guardTextWriteTarget(String(p.path ?? ""));
          const { decoded, stat } = await this.fs.readText(target);
          const format: TextFormat = {
            encoding: (p.encoding as TextEncoding | undefined) ?? decoded.encoding,
            eol: (p.eol as Eol | undefined) ?? decoded.eol,
            bom: typeof p.bom === "boolean" ? p.bom : decoded.bom,
          };
          await this.fs.writeText(target, decoded.text, format, {
            expectedVersion: stat.version,
          });
          this.viewBridge.notifyFileChanged(target);
          resultMessage = `「${target}」を ${format.encoding} / ${format.eol.toUpperCase()} へ変換して保存しました。`;
          break;
        }
      }
      action.status = "executed";
      action.resultMessage = resultMessage;
      this.emitActions();
      return action;
    } catch (error) {
      action.status = "failed";
      action.errorMessage = error instanceof Error ? error.message : String(error);
      this.emitActions();
      throw error;
    }
  }

  /** 人間専用: 確認の札を却下する。 */
  dismissAction(actor: Actor, id: string): ActionProposal {
    if (actor !== "human") {
      throw new OperationError("forbidden", "確認の札を退けられるのは利用者だけです。");
    }
    const action = this.actions.get(id);
    if (!action) throw new OperationError("not_found", "確認の札が見つかりません。");
    if (action.status === "pending") {
      action.status = "dismissed";
      this.emitActions();
    }
    return action;
  }

  /** テキストの書き込み（エージェントの場合は差分記録を残し、図面・未保存タブを保護する）。 */
  async writeTextSafe(
    actor: Actor,
    params: {
      path: string;
      text: string;
      encoding?: TextEncoding;
      eol?: Eol;
      bom?: boolean;
      expectedVersion?: string;
    },
  ): Promise<{ path: string; version: string; format: TextFormat; change?: TextChangeRecord }> {
    const path = guardTextWriteTarget(params.path);
    if (actor === "agent" && this.viewBridge.isTextDirty(path)) {
      throw new OperationError(
        "conflict",
        `「${path}」はエディターで未保存の編集中のため上書きできません。利用者に保存または破棄を依頼してください。`,
      );
    }

    let beforeText: string | null = null;
    let format: TextFormat = {
      encoding: params.encoding ?? "utf-8",
      eol: params.eol ?? "lf",
      bom: params.bom ?? false,
    };
    let expectedVersion = params.expectedVersion;

    if (await this.fs.exists(path)) {
      const existing = await this.fs.readText(path);
      beforeText = existing.decoded.text;
      // 既存ファイルでは元の文字コード・改行・BOM を勝手に変えない（明示変換は action_propose）
      format = {
        encoding: existing.decoded.encoding,
        eol: existing.decoded.eol,
        bom: existing.decoded.bom,
      };
      expectedVersion ??= existing.stat.version;
    }

    const stat = await this.fs.writeText(path, params.text, format, {
      expectedVersion,
      create: true,
    });
    this.viewBridge.notifyFileChanged(path);

    let change: TextChangeRecord | undefined;
    if (actor === "agent") {
      change = {
        id: crypto.randomUUID(),
        workspaceId: this.fs.id,
        path,
        beforeText,
        afterText: params.text,
        format,
        createdAt: Date.now(),
        reverted: false,
      };
      this.textChanges.set(change.id, change);
      await saveTextChangeRecord(change);
    }
    return { path, version: stat.version, format, ...(change ? { change } : {}) };
  }

  /** テキストの部分置換（エージェント向け）。 */
  async editTextSafe(
    actor: Actor,
    params: { path: string; oldText: string; newText: string; replaceAll?: boolean },
  ) {
    const path = guardTextWriteTarget(params.path);
    const { decoded, stat } = await this.fs.readText(path);
    if (!params.oldText) {
      throw new OperationError("bad_request", "oldText を指定してください。");
    }
    const occurrences = decoded.text.split(params.oldText).length - 1;
    if (occurrences === 0) {
      throw new OperationError("not_found", "置換対象の文字列が見つかりませんでした。");
    }
    if (occurrences > 1 && !params.replaceAll) {
      throw new OperationError(
        "conflict",
        `置換対象が ${occurrences} か所あります。周囲の行を含めて一意にするか replaceAll: true を指定してください。`,
      );
    }
    const nextText = params.replaceAll
      ? decoded.text.replaceAll(params.oldText, params.newText)
      : decoded.text.replace(params.oldText, params.newText);
    return this.writeTextSafe(actor, {
      path,
      text: nextText,
      expectedVersion: stat.version,
    });
  }

  /** 人間専用: エージェントが書き換えたテキストを元に戻す。 */
  async revertTextChange(actor: Actor, changeId: string): Promise<TextChangeRecord> {
    if (actor !== "human") {
      throw new OperationError("forbidden", "テキスト変更の復元は利用者だけが行えます。");
    }
    const record = this.textChanges.get(changeId) ?? (await getTextChangeRecord(changeId));
    if (!record) throw new OperationError("not_found", "変更記録が見つかりません。");
    if (record.reverted) return record;
    if (record.beforeText === null) {
      await this.fs.deleteEntry(record.path);
    } else {
      await this.fs.writeText(record.path, record.beforeText, record.format, { create: true });
    }
    record.reverted = true;
    this.textChanges.set(record.id, record);
    await saveTextChangeRecord(record);
    this.viewBridge.notifyFileChanged(record.path);
    return record;
  }

  async readSpreadsheet(rawPath: string) {
    const path = guardWorkspacePath(rawPath);
    if (isProtectedDrawingOrBimPath(path)) {
      throw new OperationError("bad_request", "図面ファイルは drawing_open で開いてください。");
    }
    const { bytes, stat } = await this.fs.readBytes(path);
    const parsed = await parseSpreadsheetBytes(bytes, extensionOf(path));
    return { path, version: stat.version, ...parsed };
  }

  async searchText(
    query: string,
    options?: { path?: string; caseSensitive?: boolean; regex?: boolean; limit?: number },
  ) {
    const base = options?.path ? guardWorkspacePath(options.path, { allowEmpty: true }) : "";
    return searchWorkspaceText(this.fs, query, { ...options, path: base });
  }

  async dispose(): Promise<void> {
    await this.drawings.closeAll();
  }
}
