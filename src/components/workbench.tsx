"use client";

import type { Edit, Entity } from "@zumen-jp/zumen";
import { Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAuthState,
  fetchAvailableModels,
  loginWithSiwcPopup,
  logoutAuth,
  setByokApiKey,
} from "@/kernel/agent/auth-client";
import { type ActiveRunHandle, startBrowserAgentRun } from "@/kernel/agent/runtime";
import type {
  AuthSessionState,
  ChatMessage,
  ChatSessionRecord,
  QuestionAnswer,
  RunState,
} from "@/kernel/agent/types";
import { BrowserZumenAssetLoader } from "@/kernel/drawing/assets";
import { BrowserZumenEngineFactory } from "@/kernel/drawing/engine";
import { buildSampleWorkspaceFiles, SAMPLE_DRAWING_PATH } from "@/kernel/drawing/sample-dxf";
import type {
  CheckProfileMeta,
  DrawingCheckReport,
  DrawingInfo,
  DrawingProposal,
  DrawingSceneBundle,
  SelectionAttachment,
  ViewCommand,
} from "@/kernel/drawing/types";
import {
  ensureHandleReadWritePermission,
  HandleWorkspaceFs,
  isFileSystemAccessSupported,
  pickLocalDirectory,
} from "@/kernel/fs/fsa-fs";
import { openOpfsWorkspace } from "@/kernel/fs/opfs-fs";
import { classifyFileKind, normalizeRelativePath } from "@/kernel/fs/paths";
import type { TextFormat } from "@/kernel/fs/text-codec";
import type { WorkspaceEntry, WorkspaceFs } from "@/kernel/fs/types";
import { BrowserKernel } from "@/kernel/operations/kernel";
import type { ActionProposal } from "@/kernel/operations/types";
import type { ParsedSpreadsheet } from "@/kernel/sheet/reader";
import {
  deleteChatSession,
  listChatSessions,
  loadPreferences,
  saveChatSession,
  savePreferences,
  saveRecentHandle,
} from "@/kernel/storage/idb";
import { AuthDialog } from "./auth-dialog";
import { ChatPane } from "./chat-pane";
import { DrawingView } from "./drawing-view";
import { InspectorPanel } from "./inspector-panel";
import { SheetViewer } from "./sheet-viewer";
import { TextEditor } from "./text-editor";
import { TopBar } from "./top-bar";

type OpenTab =
  | { kind: "drawing"; path: string }
  | {
      kind: "text";
      path: string;
      text: string;
      savedText: string;
      format: TextFormat;
      version: string;
    }
  | { kind: "spreadsheet"; path: string; data: ParsedSpreadsheet }
  | { kind: "image"; path: string; objectUrl: string };

function createEmptySession(workspaceId: string): ChatSessionRecord {
  return {
    id: crypto.randomUUID(),
    workspaceId,
    title: "新しい会話",
    updatedAt: Date.now(),
    messages: [],
    modelItems: [],
  };
}

export function Workbench() {
  const [kernel, setKernel] = useState<BrowserKernel | null>(null);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  // 図面状態
  const [drawingInfos, setDrawingInfos] = useState<Map<string, DrawingInfo>>(() => new Map());
  const [sceneBundles, setSceneBundles] = useState<Map<string, DrawingSceneBundle>>(
    () => new Map(),
  );
  const [loadingScene, setLoadingScene] = useState(false);
  const [placeByPath, setPlaceByPath] = useState<Map<string, string>>(() => new Map());
  const [hiddenLayersByPath, setHiddenLayersByPath] = useState<Map<string, string[]>>(
    () => new Map(),
  );
  const [selectedIdsByPath, setSelectedIdsByPath] = useState<Map<string, string[]>>(
    () => new Map(),
  );
  const [selectedEntities, setSelectedEntities] = useState<Entity[]>([]);
  const [pendingFocus, setPendingFocus] = useState<Extract<ViewCommand, { type: "focus" }> | null>(
    null,
  );
  const [profiles, setProfiles] = useState<CheckProfileMeta[]>([]);
  const [checkReport, setCheckReport] = useState<DrawingCheckReport | null>(null);
  const [checking, setChecking] = useState(false);

  // レイアウト & 環境通知
  const [chatOpen, setChatOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [chatWidth, setChatWidth] = useState(370);
  const [inspectorWidth, setInspectorWidth] = useState(290);
  const [banner, setBanner] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [fsaSupported, setFsaSupported] = useState(false);

  // 認証・モデル・チャット
  const [auth, setAuth] = useState<AuthSessionState>({
    mode: "none",
    siwcConfigured: false,
    hasPlanUsageScope: false,
    user: null,
    expiresAt: null,
  });
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("gpt-5.2");
  const [sessions, setSessions] = useState<ChatSessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [activeRun, setActiveRun] = useState<RunState | null>(null);
  const [attachment, setAttachment] = useState<SelectionAttachment | null>(null);
  const [actionsMap, setActionsMap] = useState<Map<string, ActionProposal>>(() => new Map());

  const runHandleRef = useRef<ActiveRunHandle | null>(null);
  const engineFactoryRef = useRef<BrowserZumenEngineFactory | null>(null);
  const assetsRef = useRef<BrowserZumenAssetLoader | null>(null);
  const tabsRef = useRef(tabs);
  const activePathRef = useRef(activePath);
  const placeByPathRef = useRef(placeByPath);
  const selectedIdsByPathRef = useRef(selectedIdsByPath);
  const hiddenLayersByPathRef = useRef(hiddenLayersByPath);
  tabsRef.current = tabs;
  activePathRef.current = activePath;
  placeByPathRef.current = placeByPath;
  selectedIdsByPathRef.current = selectedIdsByPath;
  hiddenLayersByPathRef.current = hiddenLayersByPath;

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((prev) => (prev === msg ? null : prev));
    }, 4500);
  }, []);

  const refreshFiles = useCallback(async (k: BrowserKernel) => {
    try {
      const { files } = await k.fs.walkFiles("", { maxFiles: 1000 });
      setEntries(files);
    } catch {
      setEntries([]);
    }
  }, []);

  const loadDrawingScene = useCallback(
    async (k: BrowserKernel, path: string, place?: string) => {
      setLoadingScene(true);
      try {
        const bundle = await k.drawings.scene(path, place, { palette: "builtin" });
        setSceneBundles((prev) => new Map(prev).set(path, bundle));
        setPlaceByPath((prev) => new Map(prev).set(path, bundle.place));
      } catch (err) {
        notify(err instanceof Error ? err.message : "図面シーンを生成できませんでした。");
      } finally {
        setLoadingScene(false);
      }
    },
    [notify],
  );

  const openFileTab = useCallback(
    async (k: BrowserKernel, rawPath: string) => {
      const path = normalizeRelativePath(rawPath);
      const kind = classifyFileKind(path);
      setActivePath(path);

      if (kind === "drawing") {
        setTabs((prev) =>
          prev.some((t) => t.path === path) ? prev : [...prev, { kind: "drawing", path }],
        );
        try {
          const info = await k.drawings.open(path);
          setDrawingInfos((prev) => new Map(prev).set(path, info));
          const place = placeByPathRef.current.get(path) ?? info.defaultPlace;
          await loadDrawingScene(k, path, place);
        } catch (err) {
          notify(err instanceof Error ? err.message : "図面を開けませんでした。");
        }
        return;
      }

      if (kind === "spreadsheet") {
        try {
          const parsed = await k.readSpreadsheet(path);
          setTabs((prev) => [
            ...prev.filter((t) => t.path !== path),
            { kind: "spreadsheet", path, data: parsed },
          ]);
        } catch (err) {
          notify(err instanceof Error ? err.message : "表ファイルを開けませんでした。");
        }
        return;
      }

      if (kind === "image") {
        try {
          const { bytes } = await k.fs.readBytes(path);
          const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
          setTabs((prev) => [
            ...prev.filter((t) => t.path !== path),
            { kind: "image", path, objectUrl: url },
          ]);
        } catch (err) {
          notify(err instanceof Error ? err.message : "画像を開けませんでした。");
        }
        return;
      }

      try {
        const { decoded, stat } = await k.fs.readText(path);
        const tab: OpenTab = {
          kind: "text",
          path,
          text: decoded.text,
          savedText: decoded.text,
          format: { encoding: decoded.encoding, eol: decoded.eol, bom: decoded.bom },
          version: stat.version,
        };
        setTabs((prev) => [...prev.filter((t) => t.path !== path), tab]);
      } catch (err) {
        notify(err instanceof Error ? err.message : "テキストファイルを開けませんでした。");
      }
    },
    [loadDrawingScene, notify],
  );

  const attachWorkspace = useCallback(
    async (fs: WorkspaceFs) => {
      if (kernel) await kernel.dispose().catch(() => undefined);
      engineFactoryRef.current ??= new BrowserZumenEngineFactory();
      assetsRef.current ??= new BrowserZumenAssetLoader();

      const nextKernel = new BrowserKernel({
        fs,
        engineFactory: engineFactoryRef.current,
        assets: assetsRef.current,
      });

      nextKernel.setViewBridge({
        getViewState: () => {
          const curPath = activePathRef.current;
          const activeTab = tabsRef.current.find((t) => t.path === curPath);
          return {
            activePath: curPath,
            openTabs: tabsRef.current.map((t) => t.path),
            ...(activeTab?.kind === "drawing"
              ? {
                  activeDrawing: {
                    path: activeTab.path,
                    place: placeByPathRef.current.get(activeTab.path) ?? "space/0",
                    selectedIds: selectedIdsByPathRef.current.get(activeTab.path) ?? [],
                    hiddenLayers: hiddenLayersByPathRef.current.get(activeTab.path) ?? [],
                  },
                }
              : {}),
          };
        },
        dispatchViewCommand: (cmd) => {
          if (cmd.type === "open") {
            void openFileTab(nextKernel, cmd.path);
          } else if (cmd.type === "focus") {
            void openFileTab(nextKernel, cmd.path).then(() => setPendingFocus(cmd));
          } else if (cmd.type === "layers") {
            setHiddenLayersByPath((prev) => {
              const current = new Set(prev.get(cmd.path) ?? []);
              for (const id of cmd.hide ?? []) current.add(id);
              for (const id of cmd.show ?? []) current.delete(id);
              return new Map(prev).set(cmd.path, [...current]);
            });
          }
        },
        isTextDirty: (p) => {
          const t = tabsRef.current.find((tab) => tab.path === p);
          return t?.kind === "text" && t.text !== t.savedText;
        },
        notifyFileChanged: (changedPath) => {
          void refreshFiles(nextKernel);
          const tab = tabsRef.current.find((t) => t.path === changedPath);
          if (tab?.kind === "text" && tab.text === tab.savedText) {
            void openFileTab(nextKernel, changedPath);
          }
        },
      });

      setTabs([]);
      setActivePath(null);
      setDrawingInfos(new Map());
      setSceneBundles(new Map());
      setCheckReport(null);
      setActionsMap(new Map());
      setKernel(nextKernel);

      await refreshFiles(nextKernel);
      const profs = await nextKernel.drawings.listCheckProfiles();
      setProfiles(profs);

      const loadedSessions = await listChatSessions(fs.id);
      if (loadedSessions.length > 0) {
        setSessions(loadedSessions as ChatSessionRecord[]);
        setActiveSessionId(loadedSessions[0]!.id);
      } else {
        const fresh = createEmptySession(fs.id);
        setSessions([fresh]);
        setActiveSessionId(fresh.id);
      }
    },
    [kernel, openFileTab, refreshFiles],
  );

  // カーネルの図面・確認札イベント購読
  useEffect(() => {
    if (!kernel) return;
    const unsubDrawings = kernel.drawings.subscribe((path) => {
      void kernel.drawings.open(path).then((info) => {
        setDrawingInfos((prev) => new Map(prev).set(path, info));
        if (activePathRef.current === path) {
          void loadDrawingScene(
            kernel,
            path,
            placeByPathRef.current.get(path) ?? info.defaultPlace,
          );
        }
      });
    });
    const unsubActions = kernel.subscribeActions(() => {
      const next = new Map<string, ActionProposal>();
      for (const a of kernel.listActions()) next.set(a.id, { ...a });
      setActionsMap(next);
    });
    const unsubFs = kernel.fs.subscribeChanges?.(() => {
      void refreshFiles(kernel);
    });
    return () => {
      unsubDrawings();
      unsubActions();
      unsubFs?.();
    };
  }, [kernel, loadDrawingScene, refreshFiles]);

  // 初回起動: Chrome / WebGPU チェック + OPFS 初期化 + 認証・モデル確認
  const loadModelsForAuth = useCallback(
    async (nextAuth: AuthSessionState) => {
      if (nextAuth.mode === "none") {
        setModels([]);
        return;
      }
      try {
        const list = await fetchAvailableModels(nextAuth);
        setModels(list);
        const prefs = await loadPreferences();
        if (prefs.model && list.includes(prefs.model)) {
          setSelectedModel(prefs.model);
        } else if (list.length > 0) {
          const preferred =
            list.find((m) => m.includes("gpt-5")) ??
            list.find((m) => m.includes("gpt-4.1")) ??
            list.find((m) => m.includes("gpt-4o")) ??
            list[0]!;
          setSelectedModel(preferred);
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : "モデル一覧の取得に失敗しました。");
      }
    },
    [notify],
  );

  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    setFsaSupported(isFileSystemAccessSupported());
    const warnings: string[] = [];
    if (typeof navigator !== "undefined" && !("gpu" in navigator)) {
      warnings.push(
        "WebGPU が利用できません（Chrome のハードウェアアクセラレーションを有効にしてください）",
      );
    }
    if (!isFileSystemAccessSupported()) {
      warnings.push(
        "File System Access API 未対応のため OPFS 一時領域モードで動作します（Chrome 推奨）",
      );
    }
    if (warnings.length > 0) setBanner(warnings.join(" / "));

    void (async () => {
      const authState = await fetchAuthState();
      setAuth(authState);
      if (authState.mode !== "none") {
        await loadModelsForAuth(authState);
      }
      try {
        const opfs = await openOpfsWorkspace();
        await attachWorkspace(opfs);
      } catch (err) {
        notify(err instanceof Error ? err.message : "ワークスペースを初期化できませんでした。");
      }
    })();
  }, [attachWorkspace, loadModelsForAuth, notify]);

  // 選択要素のプロパティ取得
  const activeDrawing = activePath ? (drawingInfos.get(activePath) ?? null) : null;
  const activeDrawingHash = activeDrawing?.hash ?? null;
  const activeSelectedIds = activePath ? (selectedIdsByPath.get(activePath) ?? []) : [];

  useEffect(() => {
    if (!kernel || !activePath || !activeDrawingHash || activeSelectedIds.length === 0) {
      setSelectedEntities([]);
      return;
    }
    let cancelled = false;
    void kernel.drawings
      .entities(activePath, { ids: activeSelectedIds.slice(0, 30), limit: 30 })
      .then((res) => {
        if (!cancelled) setSelectedEntities(res.items);
      })
      .catch(() => {
        if (!cancelled) setSelectedEntities([]);
      });
    return () => {
      cancelled = true;
    };
  }, [kernel, activePath, activeDrawingHash, activeSelectedIds]);

  const proposalsById = useMemo(() => {
    const map = new Map<string, DrawingProposal>();
    for (const info of drawingInfos.values()) {
      for (const p of info.proposals) map.set(p.id, p);
    }
    return map;
  }, [drawingInfos]);

  // 操作ハンドラー
  const handleOpenLocalFolder = async () => {
    try {
      const handle = await pickLocalDirectory();
      const granted = await ensureHandleReadWritePermission(handle);
      if (!granted) {
        notify("フォルダーへの読み書き権限が許可されませんでした。");
        return;
      }
      const id = `fsa:${handle.name}:${Date.now()}`;
      await saveRecentHandle({ id, name: handle.name, handle, openedAt: Date.now() });
      const fs = new HandleWorkspaceFs({ id, name: handle.name, kind: "fsa", root: handle });
      await attachWorkspace(fs);
      notify(`ローカルフォルダー「${handle.name}」を開きました。`);
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError") {
        notify(err instanceof Error ? err.message : "フォルダーを開けませんでした。");
      }
    }
  };

  const handleSwitchOpfs = async () => {
    try {
      const opfs = await openOpfsWorkspace();
      await attachWorkspace(opfs);
      notify("ブラウザ一時領域（OPFS）へ切り替えました。");
    } catch (err) {
      notify(err instanceof Error ? err.message : "OPFS を開けませんでした。");
    }
  };

  const handleCreateSampleDxf = async () => {
    if (!kernel) return;
    const files = buildSampleWorkspaceFiles();
    for (const [relPath, bytes] of Object.entries(files)) {
      await kernel.fs.writeBytes(relPath, bytes, { create: true });
    }
    await refreshFiles(kernel);
    await openFileTab(kernel, SAMPLE_DRAWING_PATH);
    notify(
      `サンプル一式（${Object.keys(files).join("・")}）を作成し、${SAMPLE_DRAWING_PATH} を開きました。`,
    );
  };

  const handleDropFiles = async (e: React.DragEvent) => {
    e.preventDefault();
    if (!kernel) return;
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length === 0) return;
    let firstPath: string | null = null;
    for (const file of dropped) {
      try {
        const rel = normalizeRelativePath(file.name);
        const bytes = new Uint8Array(await file.arrayBuffer());
        await kernel.fs.writeBytes(rel, bytes, { create: true });
        firstPath ??= rel;
      } catch (err) {
        notify(err instanceof Error ? err.message : `${file.name} を取り込めませんでした。`);
      }
    }
    await refreshFiles(kernel);
    if (firstPath) await openFileTab(kernel, firstPath);
  };

  const handleSaveActive = async () => {
    if (!kernel || !activePath) return;
    const tab = tabs.find((t) => t.path === activePath);
    if (!tab) return;
    try {
      if (tab.kind === "drawing") {
        await kernel.drawings.save(tab.path);
        notify(`図面「${tab.path}」を保存しました（直前ファイルを OPFS に控え保存）。`);
      } else if (tab.kind === "text") {
        const res = await kernel.writeTextSafe("human", {
          path: tab.path,
          text: tab.text,
          encoding: tab.format.encoding,
          eol: tab.format.eol,
          bom: tab.format.bom,
          expectedVersion: tab.version,
        });
        setTabs((prev) =>
          prev.map((t) =>
            t.kind === "text" && t.path === tab.path
              ? { ...t, savedText: t.text, version: res.version }
              : t,
          ),
        );
        notify(`テキスト「${tab.path}」を保存しました。`);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : "保存に失敗しました。");
    }
  };

  const handleExportDrawing = async (format: "dxf" | "svg" | "png") => {
    if (!kernel || !activePath) return;
    const stem = activePath.replace(/\.[^.]+$/, "");
    const target = `${stem}-export.${format}`;
    try {
      const out = await kernel.drawings.exportDrawing(activePath, target, format);
      await refreshFiles(kernel);
      notify(`「${out.targetPath}」（${out.bytes.toLocaleString()} B）へ書き出しました。`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "書き出しに失敗しました。");
    }
  };

  const handleDeleteSelected = async () => {
    if (!kernel || !activePath || selectedEntities.length === 0) return;
    const edits: Edit[] = selectedEntities
      .filter((e): e is Entity & { hash: string } => typeof e.hash === "string")
      .map((e) => ({ kind: "remove", id: e.id, hash: e.hash }));
    if (edits.length === 0) return;
    try {
      await kernel.drawings.applyUserEdits(activePath, edits, `選択要素 ${edits.length} 件を削除`);
      setSelectedIdsByPath((prev) => new Map(prev).set(activePath, []));
      notify(`選択要素 ${edits.length} 件を削除しました（Undo 可能）。`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "要素を削除できませんでした。");
    }
  };

  const handleRunCheck = async (profileId: string) => {
    if (!kernel || !activePath) return;
    setChecking(true);
    try {
      const report = await kernel.drawings.check(activePath, profileId);
      setCheckReport(report);
    } catch (err) {
      notify(err instanceof Error ? err.message : "基準照合に失敗しました。");
    } finally {
      setChecking(false);
    }
  };

  // チャット実行
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];

  const handleSendChat = (prompt: string) => {
    if (!kernel || !activeSession || activeRun) return;
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: prompt,
      ...(attachment ? { attachment } : {}),
    };
    const nextTitle =
      activeSession.messages.length === 0 ? prompt.slice(0, 28) : activeSession.title;
    const updatedSession: ChatSessionRecord = {
      ...activeSession,
      title: nextTitle,
      updatedAt: Date.now(),
      messages: [...activeSession.messages, userMsg],
    };
    setSessions((prev) => prev.map((s) => (s.id === updatedSession.id ? updatedSession : s)));
    const usedAttachment = attachment;
    setAttachment(null);

    const handle = startBrowserAgentRun({
      kernel,
      auth,
      model: selectedModel || "gpt-5.2",
      prompt,
      history: activeSession.modelItems,
      ...(usedAttachment ? { attachment: usedAttachment } : {}),
      onUpdate: (runState) => {
        setActiveRun(runState);
      },
    });
    runHandleRef.current = handle;

    void handle.done.then(async ({ state, history }) => {
      runHandleRef.current = null;
      setActiveRun(null);
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        items: state.items,
        ...(state.error ? { error: state.error } : {}),
        ...(state.status === "stopped" ? { stopped: true } : {}),
      };
      const finalSession: ChatSessionRecord = {
        ...updatedSession,
        updatedAt: Date.now(),
        messages: [...updatedSession.messages, assistantMsg],
        modelItems: history,
      };
      setSessions((prev) => prev.map((s) => (s.id === finalSession.id ? finalSession : s)));
      await saveChatSession(finalSession);
    });
  };

  // Ctrl+S ショートカット
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSaveActive();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;

  return (
    <div
      role="application"
      aria-label="zumen editor web ワークベンチ"
      className="workbench-root"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDropFiles}
    >
      <TopBar
        workspaceName={kernel?.fs.name ?? "初期化中..."}
        workspaceKind={kernel?.fs.kind ?? "opfs"}
        fsaSupported={fsaSupported}
        activeDrawing={activeDrawing}
        chatOpen={chatOpen}
        inspectorOpen={inspectorOpen}
        auth={auth}
        models={models}
        selectedModel={selectedModel}
        onToggleChat={() => setChatOpen((v) => !v)}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
        onOpenLocalFolder={handleOpenLocalFolder}
        onSwitchOpfs={handleSwitchOpfs}
        onCreateSampleDxf={handleCreateSampleDxf}
        onUndo={() => activePath && kernel && void kernel.drawings.undo(activePath)}
        onRedo={() => activePath && kernel && void kernel.drawings.redo(activePath)}
        onSave={() => void handleSaveActive()}
        onExport={(fmt) => void handleExportDrawing(fmt)}
        onSelectModel={(m) => {
          setSelectedModel(m);
          void loadPreferences().then((p) => savePreferences({ ...p, model: m }));
        }}
        onOpenAuthDialog={() => setAuthDialogOpen(true)}
        onQuickSiwcLogin={async () => {
          const res = await loginWithSiwcPopup();
          if (!res.ok) {
            notify(res.error ?? "ログインを完了できませんでした。");
            return;
          }
          const nextAuth = await fetchAuthState();
          setAuth(nextAuth);
          await loadModelsForAuth(nextAuth);
          notify("ChatGPT でログインしました。");
        }}
        onLogout={async () => {
          await logoutAuth();
          const nextAuth = await fetchAuthState();
          setAuth(nextAuth);
          setModels([]);
          notify("ログアウトしました。");
        }}
      />

      {banner && (
        <div className="warning-banner">
          <span>{banner}</span>
          <button type="button" className="tab-close" onClick={() => setBanner(null)}>
            <X size={13} />
          </button>
        </div>
      )}

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 34,
            right: 16,
            zIndex: 40,
            background: "#0f172a",
            color: "#f8fafc",
            padding: "8px 12px",
            borderRadius: 8,
            boxShadow: "0 10px 25px rgba(15,23,42,0.25)",
            fontSize: 12,
          }}
        >
          {toast}
        </div>
      )}

      <div className="workbench-body">
        {chatOpen && activeSession && (
          <>
            <ChatPane
              widthPx={chatWidth}
              auth={auth}
              sessions={sessions}
              activeSessionId={activeSession.id}
              messages={activeSession.messages}
              activeRun={activeRun}
              attachment={attachment}
              proposalsById={proposalsById}
              actionsById={actionsMap}
              onSelectSession={setActiveSessionId}
              onNewSession={() => {
                if (!kernel) return;
                const fresh = createEmptySession(kernel.fs.id);
                setSessions((prev) => [fresh, ...prev]);
                setActiveSessionId(fresh.id);
              }}
              onDeleteSession={async (id) => {
                await deleteChatSession(id);
                setSessions((prev) => {
                  const rest = prev.filter((s) => s.id !== id);
                  if (rest.length > 0) {
                    setActiveSessionId(rest[0]!.id);
                    return rest;
                  }
                  const fresh = createEmptySession(kernel?.fs.id ?? "opfs:default");
                  setActiveSessionId(fresh.id);
                  return [fresh];
                });
              }}
              onClearAttachment={() => setAttachment(null)}
              onSend={handleSendChat}
              onStop={() => runHandleRef.current?.stop()}
              onAnswerQuestion={(qid, ans: QuestionAnswer) =>
                runHandleRef.current?.answerQuestion(qid, ans)
              }
              onApplyProposal={async (path, proposalId) => {
                if (!kernel) return;
                try {
                  await kernel.drawings.applyProposal(path, proposalId);
                  notify("変更案を図面へ当てました（保存は Ctrl+S で行えます）。");
                } catch (err) {
                  notify(err instanceof Error ? err.message : "変更案を当てられませんでした。");
                }
              }}
              onDismissProposal={async (path, proposalId) => {
                if (!kernel) return;
                await kernel.drawings.dismissProposal(path, proposalId);
              }}
              onExecuteAction={async (actionId) => {
                if (!kernel) return;
                try {
                  const done = await kernel.executeAction("human", actionId);
                  notify(done.resultMessage ?? "確認の札を実行しました。");
                } catch (err) {
                  notify(err instanceof Error ? err.message : "操作を実行できませんでした。");
                }
              }}
              onDismissAction={(actionId) => {
                kernel?.dismissAction("human", actionId);
              }}
              onRevertTextChange={async (changeId) => {
                if (!kernel) return;
                try {
                  const rec = await kernel.revertTextChange("human", changeId);
                  notify(`「${rec.path}」を変更前へ戻しました。`);
                } catch (err) {
                  notify(err instanceof Error ? err.message : "元に戻せませんでした。");
                }
              }}
              onOpenFile={(p) => kernel && void openFileTab(kernel, p)}
              onOpenAuthDialog={() => setAuthDialogOpen(true)}
            />
            <div
              className="splitter"
              onPointerDown={(e) => {
                const startX = e.clientX;
                const startW = chatWidth;
                const onMove = (mv: PointerEvent) => {
                  setChatWidth(Math.max(260, Math.min(640, startW + (mv.clientX - startX))));
                };
                const onUp = () => {
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
              }}
            />
          </>
        )}

        <main className="pane pane-center">
          <div className="tab-strip">
            {tabs.map((tab) => {
              const isDirty =
                (tab.kind === "drawing" && drawingInfos.get(tab.path)?.dirty) ||
                (tab.kind === "text" && tab.text !== tab.savedText);
              return (
                <div
                  key={tab.path}
                  role="tab"
                  tabIndex={0}
                  aria-selected={tab.path === activePath}
                  className={`tab-item ${tab.path === activePath ? "active" : ""}`}
                  onClick={() => setActivePath(tab.path)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setActivePath(tab.path);
                  }}
                >
                  <span>
                    {tab.path}
                    {isDirty ? " ●" : ""}
                  </span>
                  <button
                    type="button"
                    className="tab-close"
                    aria-label="タブを閉じる"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (tab.kind === "image") URL.revokeObjectURL(tab.objectUrl);
                      setTabs((prev) => {
                        const next = prev.filter((t) => t.path !== tab.path);
                        if (activePath === tab.path) {
                          setActivePath(next[next.length - 1]?.path ?? null);
                        }
                        return next;
                      });
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>

          {!activeTab ? (
            <div className="empty-stage">
              <Upload size={34} color="#94a3b8" />
              <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>
                Chrome 内で図面をそのまま読み・描き・直す
              </div>
              <p style={{ margin: 0, maxWidth: 480, lineHeight: 1.7 }}>
                DXF・DWG・JWW・SXF・CSV/TSV/XLSX・テキストファイルをここへドラッグ＆ドロップするか、
                上の「フォルダーを開く」（Chrome ローカルフォルダー）または「+
                サンプル図面」から始められます。
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                <button type="button" className="btn btn-accent" onClick={handleCreateSampleDxf}>
                  + サンプル図面一式（1階平面図・仕上表）を開く
                </button>
                {fsaSupported && (
                  <button type="button" className="btn" onClick={handleOpenLocalFolder}>
                    ローカルフォルダーを開く
                  </button>
                )}
              </div>
            </div>
          ) : activeTab.kind === "drawing" && activeDrawing ? (
            <DrawingView
              info={activeDrawing}
              sceneBundle={sceneBundles.get(activeTab.path) ?? null}
              loadingScene={loadingScene}
              place={placeByPath.get(activeTab.path) ?? activeDrawing.defaultPlace}
              hiddenLayers={hiddenLayersByPath.get(activeTab.path) ?? []}
              selectedIds={activeSelectedIds}
              pendingFocus={pendingFocus}
              onConsumeFocus={() => setPendingFocus(null)}
              onPlaceChange={(nextPlace) => {
                setPlaceByPath((prev) => new Map(prev).set(activeTab.path, nextPlace));
                if (kernel) void loadDrawingScene(kernel, activeTab.path, nextPlace);
              }}
              onSelectionChange={(ids) => {
                setSelectedIdsByPath((prev) => new Map(prev).set(activeTab.path, ids));
              }}
              onAttachSelection={() => {
                setAttachment({
                  path: activeTab.path,
                  place: placeByPath.get(activeTab.path) ?? activeDrawing.defaultPlace,
                  elements: selectedEntities.map((e) => ({
                    id: e.id,
                    kind: e.kind,
                    layer: e.layer,
                    bbox: e.bbox,
                  })),
                  total: activeSelectedIds.length,
                });
                setChatOpen(true);
              }}
            />
          ) : activeTab.kind === "text" ? (
            <TextEditor
              path={activeTab.path}
              value={activeTab.text}
              format={activeTab.format}
              dirty={activeTab.text !== activeTab.savedText}
              onChange={(nextText) =>
                setTabs((prev) =>
                  prev.map((t) =>
                    t.kind === "text" && t.path === activeTab.path ? { ...t, text: nextText } : t,
                  ),
                )
              }
              onSave={() => void handleSaveActive()}
            />
          ) : activeTab.kind === "spreadsheet" ? (
            <SheetViewer path={activeTab.path} spreadsheet={activeTab.data} />
          ) : activeTab.kind === "image" ? (
            <div
              style={{
                flex: 1,
                overflow: "auto",
                padding: 16,
                display: "grid",
                placeItems: "center",
              }}
            >
              {/* biome-ignore lint/performance/noImgElement: local Object URL preview */}
              <img
                src={activeTab.objectUrl}
                alt={activeTab.path}
                style={{ maxWidth: "100%", maxHeight: "100%", border: "1px solid #cbd5e1" }}
              />
            </div>
          ) : (
            <div className="empty-stage">読み込み中...</div>
          )}
        </main>

        {inspectorOpen && (
          <>
            <div
              className="splitter"
              onPointerDown={(e) => {
                const startX = e.clientX;
                const startW = inspectorWidth;
                const onMove = (mv: PointerEvent) => {
                  setInspectorWidth(Math.max(220, Math.min(480, startW - (mv.clientX - startX))));
                };
                const onUp = () => {
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
              }}
            />
            <InspectorPanel
              widthPx={inspectorWidth}
              entries={entries}
              activePath={activePath}
              activeDrawing={activeDrawing}
              hiddenLayers={activePath ? (hiddenLayersByPath.get(activePath) ?? []) : []}
              selectedEntities={selectedEntities}
              profiles={profiles}
              checkReport={checkReport}
              checking={checking}
              onRefreshFiles={() => kernel && void refreshFiles(kernel)}
              onOpenFile={(p) => kernel && void openFileTab(kernel, p)}
              onSearchText={async (q) => {
                if (!kernel) return [];
                const res = await kernel.searchText(q);
                return res.matches;
              }}
              onToggleLayer={(layerId) => {
                if (!activePath) return;
                setHiddenLayersByPath((prev) => {
                  const set = new Set(prev.get(activePath) ?? []);
                  if (set.has(layerId)) set.delete(layerId);
                  else set.add(layerId);
                  return new Map(prev).set(activePath, [...set]);
                });
              }}
              onRunCheck={(pid) => void handleRunCheck(pid)}
              onDeleteSelectedEntities={() => void handleDeleteSelected()}
              onFocusElements={(ids) => {
                if (!activePath) return;
                setPendingFocus({ type: "focus", path: activePath, elements: ids });
              }}
            />
          </>
        )}
      </div>

      {authDialogOpen && (
        <AuthDialog
          auth={auth}
          onClose={() => setAuthDialogOpen(false)}
          onLoginSiwc={async () => {
            const res = await loginWithSiwcPopup();
            if (!res.ok) throw new Error(res.error ?? "ログインできませんでした。");
            const next = await fetchAuthState();
            setAuth(next);
            await loadModelsForAuth(next);
          }}
          onSaveByok={async (key) => {
            setByokApiKey(key);
            const next = await fetchAuthState();
            setAuth(next);
            await loadModelsForAuth(next);
          }}
          onLogout={async () => {
            await logoutAuth();
            const next = await fetchAuthState();
            setAuth(next);
            setModels([]);
          }}
        />
      )}
    </div>
  );
}
