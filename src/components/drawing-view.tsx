"use client";

import { useDrawingViewer, useViewerEvent } from "@zumen-jp/react";
import type { ElementRef, Measurement, View2D } from "@zumen-jp/view2d";
import { readScene } from "@zumen-jp/zumen";
import { Hand, Maximize, Moon, MousePointer, Ruler, Sun, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DrawingInfo,
  DrawingProposal,
  DrawingSceneBundle,
  ViewCommand,
} from "@/kernel/drawing/types";

type DrawingViewProps = {
  info: DrawingInfo;
  sceneBundle: DrawingSceneBundle | null;
  loadingScene: boolean;
  place: string;
  hiddenLayers: string[];
  selectedIds: string[];
  pendingFocus: Extract<ViewCommand, { type: "focus" }> | null;
  onConsumeFocus: () => void;
  onPlaceChange: (place: string) => void;
  onSelectionChange: (ids: string[]) => void;
  onAttachSelection: () => void;
};

const PROPOSAL_COLORS: Record<string, string> = {
  add: "#16a34a",
  replace: "#d97706",
  transform: "#d97706",
  restyle: "#2563eb",
  remove: "#dc2626",
};

export function DrawingView({
  info,
  sceneBundle,
  loadingScene,
  place,
  hiddenLayers,
  selectedIds,
  pendingFocus,
  onConsumeFocus,
  onPlaceChange,
  onSelectionChange,
  onAttachSelection,
}: DrawingViewProps) {
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const [toolMode, setToolMode] = useState<"select" | "pan" | "measure">("select");
  const [darkPaper, setDarkPaper] = useState(false);
  const [webgpuError, setWebgpuError] = useState<string | null>(null);
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [showProposals, setShowProposals] = useState(true);
  const fittedKeyRef = useRef<string>("");

  const viewerOptions = useMemo(
    () => ({
      background: darkPaper ? "#0f172a" : "#ffffff",
      foreground: darkPaper ? "#f8fafc" : "#111111",
      unresolvedColor: "#777777",
      selectionColor: "#f97316",
      hoverColor: "#0284c7",
      overlayColor: "#db2777",
    }),
    [darkPaper],
  );

  const viewer: View2D | null = useDrawingViewer(canvasEl, viewerOptions, (err) => {
    setWebgpuError(err.message || "WebGPU ビューアーを初期化できませんでした。");
  });

  // Canvas リサイズと入力接続
  useEffect(() => {
    if (!viewer || !canvasEl) return;
    const detach = viewer.attachInput(canvasEl, { wheelModifier: "none" });
    const updateSize = () => {
      const rect = canvasEl.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        viewer.resize(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2));
      }
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(canvasEl);
    return () => {
      ro.disconnect();
      detach();
    };
  }, [viewer, canvasEl]);

  // ツール切替
  useEffect(() => {
    if (!viewer) return;
    try {
      viewer.setTool(toolMode);
    } catch {
      // ignore
    }
  }, [viewer, toolMode]);

  // シーン投入
  useEffect(() => {
    if (!viewer || !sceneBundle) return;
    try {
      const parsedScene = readScene(sceneBundle.blob);
      viewer.setScene({
        scene: parsedScene,
        result: sceneBundle.result,
        document: {
          doc: sceneBundle.doc,
          format: sceneBundle.format,
          hash: sceneBundle.hash,
        },
      });
      const fitKey = `${sceneBundle.path}:${sceneBundle.place}`;
      if (fittedKeyRef.current !== fitKey) {
        fittedKeyRef.current = fitKey;
        viewer.fit(32);
      }
    } catch (err) {
      setWebgpuError(err instanceof Error ? err.message : "シーンを描画できませんでした。");
    }
  }, [viewer, sceneBundle]);

  // 非表示レイヤ反映
  useEffect(() => {
    if (!viewer || !sceneBundle) return;
    try {
      viewer.setHiddenLayers(hiddenLayers);
    } catch {
      // ignore
    }
  }, [viewer, sceneBundle, hiddenLayers]);

  // 変更案の重ね描き（pending proposals）
  const pendingProposals = useMemo<DrawingProposal[]>(
    () => info.proposals.filter((p) => p.status === "pending"),
    [info.proposals],
  );

  useEffect(() => {
    if (!viewer || !showProposals || pendingProposals.length === 0) return;
    const removeOverlay = viewer.addOverlay((ctx) => {
      for (const proposal of pendingProposals) {
        for (const item of proposal.overlays) {
          if (!item.bbox) continue;
          const color = PROPOSAL_COLORS[item.kind] ?? "#2563eb";
          const p1 = viewer.toScreen({ x: item.bbox.min_x, y: item.bbox.max_y });
          const p2 = viewer.toScreen({ x: item.bbox.max_x, y: item.bbox.min_y });
          const x = Math.min(p1.x, p2.x) - 4;
          const y = Math.min(p1.y, p2.y) - 4;
          const w = Math.max(12, Math.abs(p2.x - p1.x) + 8);
          const h = Math.max(12, Math.abs(p2.y - p1.y) + 8);
          ctx.save();
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(x, y, w, h);
          ctx.globalAlpha = 0.12;
          ctx.fillRect(x, y, w, h);
          ctx.restore();
        }
      }
    });
    viewer.invalidate();
    return () => {
      removeOverlay();
      viewer.invalidate();
    };
  }, [viewer, showProposals, pendingProposals]);

  // フォーカス要求（view_focus）
  useEffect(() => {
    if (!viewer || !pendingFocus || pendingFocus.path !== info.path) return;
    try {
      if (pendingFocus.region) {
        const [min_x, min_y, max_x, max_y] = pendingFocus.region;
        viewer.fitBounds({ min_x, min_y, max_x, max_y }, 40);
      }
      if (pendingFocus.elements?.length) {
        const wanted = new Set(pendingFocus.elements);
        const refs = viewer.getElements().filter((el) => wanted.has(el.id));
        if (refs.length > 0) {
          viewer.setHighlight("agent-focus", refs, "#2563eb");
          viewer.select(refs, "replace");
        }
      }
    } catch {
      // ignore
    } finally {
      onConsumeFocus();
    }
  }, [viewer, pendingFocus, info.path, onConsumeFocus]);

  // 選択・計測イベント購読
  useViewerEvent(viewer, "selection", (ev) => {
    const ids = Array.from(new Set(ev.state.selection.map((ref: ElementRef) => ref.id)));
    onSelectionChange(ids);
  });

  useViewerEvent(viewer, "measurement", (ev) => {
    setMeasurement(ev.state.measurement);
  });

  const places = useMemo(() => {
    const list: { id: string; label: string }[] = [];
    for (const s of info.drawing.spaces) {
      if (!s.id) continue;
      list.push({ id: s.id, label: `モデル空間 (${s.id})` });
    }
    for (const sh of info.drawing.sheets) {
      if (!sh.id) continue;
      list.push({ id: sh.id, label: `用紙: ${sh.name || sh.id}` });
    }
    return list;
  }, [info.drawing]);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="sub-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          <button
            type="button"
            className={`btn ${toolMode === "select" ? "active" : ""}`}
            onClick={() => setToolMode("select")}
            title="要素選択"
          >
            <MousePointer size={13} />
            <span>選択</span>
          </button>
          <button
            type="button"
            className={`btn ${toolMode === "pan" ? "active" : ""}`}
            onClick={() => setToolMode("pan")}
            title="画面移動（パン）"
          >
            <Hand size={13} />
            <span>移動</span>
          </button>
          <button
            type="button"
            className={`btn ${toolMode === "measure" ? "active" : ""}`}
            onClick={() => setToolMode("measure")}
            title="2 点距離計測"
          >
            <Ruler size={13} />
            <span>計測</span>
          </button>

          <span style={{ width: 1, height: 18, background: "#e2e8f0", margin: "0 4px" }} />

          <button type="button" className="btn" onClick={() => viewer?.zoomBy(1.25)} title="拡大">
            <ZoomIn size={13} />
          </button>
          <button type="button" className="btn" onClick={() => viewer?.zoomBy(0.8)} title="縮小">
            <ZoomOut size={13} />
          </button>
          <button type="button" className="btn" onClick={() => viewer?.fit(32)} title="全体表示">
            <Maximize size={13} />
            <span>全体</span>
          </button>

          {places.length > 1 && (
            <select
              value={place}
              onChange={(e) => onPlaceChange(e.target.value)}
              style={{
                height: 27,
                padding: "0 8px",
                borderRadius: 6,
                border: "1px solid #cbd5e1",
                background: "#fff",
              }}
            >
              {places.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {pendingProposals.length > 0 && (
            <button
              type="button"
              className={`btn ${showProposals ? "btn-accent" : ""}`}
              onClick={() => setShowProposals((v) => !v)}
            >
              <span>変更案重ね描き ({pendingProposals.length})</span>
            </button>
          )}
          {selectedIds.length > 0 && (
            <button type="button" className="btn btn-accent" onClick={onAttachSelection}>
              <span>選択 {selectedIds.length} 件をチャットへ添付</span>
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => setDarkPaper((v) => !v)}
            title="背景色切替"
          >
            {darkPaper ? <Sun size={13} /> : <Moon size={13} />}
          </button>
        </div>
      </div>

      <div className="canvas-host" style={{ background: darkPaper ? "#0f172a" : "#ffffff" }}>
        {webgpuError ? (
          <div className="empty-stage">
            <p style={{ fontWeight: 700, color: "#b91c1c", margin: 0 }}>
              WebGPU で図面を表示できませんでした
            </p>
            <p style={{ margin: 0, maxWidth: 420 }}>{webgpuError}</p>
            <p style={{ margin: 0, fontSize: 12 }}>
              Chrome のハードウェアアクセラレーションと WebGPU が有効であることを確認してください。
            </p>
          </div>
        ) : (
          <canvas ref={setCanvasEl} tabIndex={0} />
        )}
        {loadingScene && (
          <div
            style={{
              position: "absolute",
              top: 10,
              right: 12,
              padding: "4px 10px",
              borderRadius: 999,
              background: "rgba(15, 23, 42, 0.78)",
              color: "#fff",
              fontSize: 11.5,
            }}
          >
            WASM シーン生成中...
          </div>
        )}
      </div>

      <div className="status-bar">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>形式: {info.format.toUpperCase()}</span>
          <span>起点: {place}</span>
          {sceneBundle && (
            <span>
              線分 {sceneBundle.result.counts.lines.toLocaleString()} / 面{" "}
              {sceneBundle.result.counts.faces.toLocaleString()} / 文字{" "}
              {sceneBundle.result.counts.texts.toLocaleString()}
            </span>
          )}
          {selectedIds.length > 0 && <span>選択中: {selectedIds.length} 件</span>}
        </div>
        <div>
          {measurement ? (
            <span style={{ color: "#db2777", fontWeight: 600 }}>
              計測距離: {measurement.distance.toFixed(2)} (dx={measurement.delta.x.toFixed(2)}, dy=
              {measurement.delta.y.toFixed(2)})
            </span>
          ) : (
            <span>WebGPU + zumen WASM</span>
          )}
        </div>
      </div>
    </div>
  );
}
