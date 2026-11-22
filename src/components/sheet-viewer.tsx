"use client";

import { useMemo, useState } from "react";
import type { ParsedSpreadsheet } from "@/kernel/sheet/reader";

type SheetViewerProps = {
  path: string;
  spreadsheet: ParsedSpreadsheet;
};

function colLabel(colIndex: number): string {
  let n = colIndex + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function SheetViewer({ path, spreadsheet }: SheetViewerProps) {
  const [sheetIdx, setSheetIdx] = useState(0);
  const sheet = spreadsheet.sheets[sheetIdx] ?? spreadsheet.sheets[0];

  const maxDisplayRows = Math.min(sheet?.rows ?? 0, 200);
  const maxDisplayCols = Math.min(sheet?.columns ?? 0, 50);

  const cellMap = useMemo(() => {
    const map = new Map<string, { value: string; formula?: string }>();
    if (!sheet) return map;
    for (const c of sheet.cells) {
      if (c.row < maxDisplayRows && c.column < maxDisplayCols) {
        map.set(`${c.row}:${c.column}`, { value: c.value, formula: c.formula });
      }
    }
    return map;
  }, [sheet, maxDisplayRows, maxDisplayCols]);

  const colHeaders = useMemo(
    () => Array.from({ length: maxDisplayCols }, (_, c) => ({ index: c, label: colLabel(c) })),
    [maxDisplayCols],
  );
  const rowIndices = useMemo(
    () => Array.from({ length: maxDisplayRows }, (_, r) => r),
    [maxDisplayRows],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="sub-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600 }}>{path}</span>
          <span className="badge">{spreadsheet.format.toUpperCase()}</span>
          {spreadsheet.encoding && (
            <span className="badge">{spreadsheet.encoding.toUpperCase()}</span>
          )}
          {spreadsheet.sheets.map((s, idx) => (
            <button
              key={s.name}
              type="button"
              className={`btn ${idx === sheetIdx ? "active" : ""}`}
              onClick={() => setSheetIdx(idx)}
            >
              {s.name}
            </button>
          ))}
        </div>
        {sheet && (
          <span style={{ fontSize: 11.5, color: "#64748b" }}>
            {sheet.rows} 行 × {sheet.columns} 列（先頭 {maxDisplayRows} 行を表示）
          </span>
        )}
      </div>

      {spreadsheet.warnings.length > 0 && (
        <div className="warning-banner">
          <span>{spreadsheet.warnings.join(" / ")}</span>
        </div>
      )}

      <div style={{ flex: 1, overflow: "auto", background: "#fff" }}>
        {sheet && maxDisplayRows > 0 ? (
          <table className="sheet-table">
            <thead>
              <tr>
                <th>#</th>
                {colHeaders.map((col) => (
                  <th key={`col-${col.label}`}>{col.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowIndices.map((r) => (
                <tr key={`row-${r + 1}`}>
                  <th>{r + 1}</th>
                  {colHeaders.map((col) => {
                    const cell = cellMap.get(`${r}:${col.index}`);
                    return (
                      <td
                        key={`cell-${r + 1}-${col.label}`}
                        title={cell?.formula ? `=${cell.formula}` : undefined}
                      >
                        {cell?.value ?? ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-stage">表示できるセルがありません。</div>
        )}
      </div>
    </div>
  );
}
