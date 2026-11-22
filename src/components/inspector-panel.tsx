"use client";

import type { Entity } from "@zumen-jp/zumen";
import {
  CheckSquare,
  Eye,
  EyeOff,
  FileCode,
  FileSpreadsheet,
  FileText,
  Folder,
  Layers,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type { CheckProfileMeta, DrawingCheckReport, DrawingInfo } from "@/kernel/drawing/types";
import { classifyFileKind } from "@/kernel/fs/paths";
import type { SearchMatch } from "@/kernel/fs/search";
import type { WorkspaceEntry } from "@/kernel/fs/types";

type InspectorTab = "files" | "layers" | "props" | "check";

type InspectorPanelProps = {
  widthPx: number;
  entries: WorkspaceEntry[];
  activePath: string | null;
  activeDrawing: DrawingInfo | null;
  hiddenLayers: string[];
  selectedEntities: Entity[];
  profiles: CheckProfileMeta[];
  checkReport: DrawingCheckReport | null;
  checking: boolean;
  onRefreshFiles: () => void;
  onOpenFile: (path: string) => void;
  onSearchText: (query: string) => Promise<SearchMatch[]>;
  onToggleLayer: (layerId: string) => void;
  onRunCheck: (profileId: string) => void;
  onDeleteSelectedEntities: () => void;
  onFocusElements: (ids: string[]) => void;
};

export function InspectorPanel({
  widthPx,
  entries,
  activePath,
  activeDrawing,
  hiddenLayers,
  selectedEntities,
  profiles,
  checkReport,
  checking,
  onRefreshFiles,
  onOpenFile,
  onSearchText,
  onToggleLayer,
  onRunCheck,
  onDeleteSelectedEntities,
  onFocusElements,
}: InspectorPanelProps) {
  const [tab, setTab] = useState<InspectorTab>("files");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<SearchMatch[] | null>(null);
  const [selectedProfile, setSelectedProfile] = useState("mlit-cad");

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) {
      setMatches(null);
      return;
    }
    const found = await onSearchText(query.trim());
    setMatches(found);
  };

  const hiddenSet = new Set(hiddenLayers);

  return (
    <aside className="pane pane-right" style={{ width: widthPx }}>
      <div className="inspector-tabs">
        <button
          type="button"
          className={`inspector-tab ${tab === "files" ? "active" : ""}`}
          onClick={() => setTab("files")}
        >
          ファイル
        </button>
        <button
          type="button"
          className={`inspector-tab ${tab === "layers" ? "active" : ""}`}
          onClick={() => setTab("layers")}
        >
          レイヤ
        </button>
        <button
          type="button"
          className={`inspector-tab ${tab === "props" ? "active" : ""}`}
          onClick={() => setTab("props")}
        >
          プロパティ
        </button>
        <button
          type="button"
          className={`inspector-tab ${tab === "check" ? "active" : ""}`}
          onClick={() => setTab("check")}
        >
          照合・診断
        </button>
      </div>

      <div className="inspector-body">
        {tab === "files" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 4 }}>
              <form onSubmit={runSearch} style={{ display: "flex", gap: 4, flex: 1 }}>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="テキスト横断検索..."
                  style={{
                    flex: 1,
                    minWidth: 0,
                    height: 27,
                    padding: "0 8px",
                    borderRadius: 6,
                    border: "1px solid #cbd5e1",
                    fontSize: 12,
                  }}
                />
                <button type="submit" className="btn" title="検索">
                  <Search size={13} />
                </button>
              </form>
              <button type="button" className="btn" onClick={onRefreshFiles} title="一覧を更新">
                <RefreshCw size={13} />
              </button>
            </div>

            {matches !== null ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}>
                  <span>検索結果: {matches.length} 件</span>
                  <button type="button" className="btn" onClick={() => setMatches(null)}>
                    一覧へ戻る
                  </button>
                </div>
                {matches.map((m) => (
                  <button
                    key={`${m.path}:${m.line}:${m.column}`}
                    type="button"
                    className="tree-row"
                    style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}
                    onClick={() => onOpenFile(m.path)}
                  >
                    <span style={{ fontWeight: 600 }}>
                      {m.path}:{m.line}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: "#64748b",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        maxWidth: "100%",
                      }}
                    >
                      {m.preview}
                    </span>
                  </button>
                ))}
              </div>
            ) : entries.length === 0 ? (
              <p style={{ color: "#64748b", fontSize: 12, lineHeight: 1.6 }}>
                ファイルがありません。上部バーの「+ サンプル
                DXF」またはファイルをドラッグ＆ドロップしてください。
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {entries.map((entry) => {
                  const kind = entry.kind === "file" ? classifyFileKind(entry.path) : "dir";
                  return (
                    <button
                      key={entry.path}
                      type="button"
                      className={`tree-row ${entry.path === activePath ? "active" : ""}`}
                      onClick={() => entry.kind === "file" && onOpenFile(entry.path)}
                    >
                      {kind === "dir" ? (
                        <Folder size={14} color="#64748b" />
                      ) : kind === "drawing" ? (
                        <Layers size={14} color="#2563eb" />
                      ) : kind === "spreadsheet" ? (
                        <FileSpreadsheet size={14} color="#15803d" />
                      ) : kind === "text" ? (
                        <FileText size={14} color="#475569" />
                      ) : (
                        <FileCode size={14} color="#7c3aed" />
                      )}
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {entry.path}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === "layers" && (
          <div>
            {!activeDrawing ? (
              <p style={{ color: "#64748b", fontSize: 12 }}>
                図面タブを開くとレイヤ一覧が表示されます。
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <div style={{ fontSize: 11.5, color: "#64748b", marginBottom: 4 }}>
                  レイヤ数: {activeDrawing.tables.layers.length}
                </div>
                {activeDrawing.tables.layers.map((layer) => {
                  const hidden = hiddenSet.has(layer.id);
                  return (
                    <button
                      key={layer.id}
                      type="button"
                      className="tree-row"
                      onClick={() => onToggleLayer(layer.id)}
                      style={{ opacity: hidden ? 0.45 : 1 }}
                    >
                      {hidden ? <EyeOff size={14} /> : <Eye size={14} color="#2563eb" />}
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {layer.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === "props" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {!activeDrawing ? (
              <p style={{ color: "#64748b", fontSize: 12 }}>
                図面で要素を選択するとプロパティが表示されます。
              </p>
            ) : selectedEntities.length === 0 ? (
              <p style={{ color: "#64748b", fontSize: 12 }}>
                図面上の要素をクリックまたはドラッグで選択してください。
              </p>
            ) : (
              <>
                <div
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
                >
                  <strong>選択要素（{selectedEntities.length} 件）</strong>
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={onDeleteSelectedEntities}
                    title="選択要素を削除（Undo 可能）"
                  >
                    <Trash2 size={12} />
                    <span>削除</span>
                  </button>
                </div>
                {selectedEntities.slice(0, 20).map((ent) => (
                  <div key={ent.id} className="tool-card">
                    <div
                      style={{ fontWeight: 700, fontFamily: "var(--font-mono)", fontSize: 11.5 }}
                    >
                      {ent.id}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 11.5, color: "#475569" }}>
                      種類: <strong>{ent.kind ?? "不明"}</strong> / レイヤ:{" "}
                      <strong>{ent.layer ?? "(なし)"}</strong>
                    </div>
                    {ent.geometry && (
                      <pre
                        style={{
                          margin: "6px 0 0",
                          padding: 6,
                          borderRadius: 4,
                          background: "#ffffff",
                          border: "1px solid #e2e8f0",
                          fontSize: 11,
                          overflowX: "auto",
                        }}
                      >
                        {JSON.stringify(ent.geometry, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {tab === "check" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {!activeDrawing ? (
              <p style={{ color: "#64748b", fontSize: 12 }}>
                図面タブを開くと照合・診断を実行できます。
              </p>
            ) : (
              <>
                <div style={{ display: "flex", gap: 6 }}>
                  <select
                    value={selectedProfile}
                    onChange={(e) => setSelectedProfile(e.target.value)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      height: 27,
                      padding: "0 6px",
                      borderRadius: 6,
                      border: "1px solid #cbd5e1",
                      background: "#fff",
                      fontSize: 12,
                    }}
                  >
                    {(profiles.length > 0
                      ? profiles
                      : [{ id: "mlit-cad", edition: "2025-12", title: "CAD製図基準", revision: 1 }]
                    ).map((p) => (
                      <option key={`${p.id}/${p.edition}`} value={p.id}>
                        {p.title} ({p.edition})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-accent"
                    disabled={checking}
                    onClick={() => onRunCheck(selectedProfile)}
                  >
                    <CheckSquare size={13} />
                    <span>{checking ? "照合中..." : "照合"}</span>
                  </button>
                </div>

                {checkReport && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>
                      照合結果: 指摘 {checkReport.totalFindings} 件（うち要確認{" "}
                      {checkReport.groups.reduce((s, g) => s + g.count, 0)} 件）
                    </div>
                    {checkReport.groups.length === 0 ? (
                      <span className="badge badge-ok">違反指摘はありませんでした</span>
                    ) : (
                      checkReport.groups.map((g) => (
                        <div key={`${g.ruleId}:${g.severity}`} className="tool-card">
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 4 }}>
                            <strong>{g.ruleId}</strong>
                            <span className="badge badge-warn">{g.count} 件</span>
                          </div>
                          <div style={{ fontSize: 11.5, color: "#475569", marginTop: 2 }}>
                            {g.sampleMessages.join(" / ")}
                          </div>
                          {g.sampleElements.length > 0 && (
                            <button
                              type="button"
                              className="btn"
                              style={{ marginTop: 6 }}
                              onClick={() => onFocusElements(g.sampleElements)}
                            >
                              該当要素を表示
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}

                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
                    図面の診断（{activeDrawing.diagnostics.length} 件）
                  </div>
                  {activeDrawing.diagnostics.length === 0 ? (
                    <span className="badge badge-ok">診断メッセージなし</span>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {activeDrawing.diagnostics.map((d) => (
                        <div key={`${d.stage}:${d.code}:${d.text}`} className="tool-card">
                          <span
                            className={`badge ${
                              d.severity === "error"
                                ? "badge-err"
                                : d.severity === "warning"
                                  ? "badge-warn"
                                  : ""
                            }`}
                          >
                            {d.code} ×{d.count}
                          </span>
                          <div style={{ marginTop: 3, fontSize: 11.5 }}>{d.text}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
