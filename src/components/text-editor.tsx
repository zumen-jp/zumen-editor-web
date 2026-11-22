"use client";

import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { Save } from "lucide-react";
import { useEffect, useRef } from "react";
import { extensionOf } from "@/kernel/fs/paths";
import type { TextFormat } from "@/kernel/fs/text-codec";

type TextEditorProps = {
  path: string;
  value: string;
  format: TextFormat;
  dirty: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
};

function langExtension(path: string) {
  const ext = extensionOf(path);
  if (ext === "json") return [json()];
  if (ext === "js" || ext === "mjs" || ext === "ts" || ext === "tsx") {
    return [javascript({ typescript: ext.startsWith("ts"), jsx: ext.endsWith("x") })];
  }
  if (ext === "md") return [markdown()];
  if (ext === "xml" || ext === "svg" || ext === "html") return [xml()];
  return [];
}

export function TextEditor({ path, value, format, dirty, onChange, onSave }: TextEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialValueRef = useRef(value);
  initialValueRef.current = value;
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: initialValueRef.current,
      extensions: [
        basicSetup,
        ...langExtension(path),
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              onSaveRef.current();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px" },
          ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)" },
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [path]);

  // 外部更新（エージェント書き換え・復元・再読込）の同期
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="sub-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 600 }}>{path}</span>
          <span className="badge">{format.encoding.toUpperCase()}</span>
          <span className="badge">{format.eol.toUpperCase()}</span>
          {format.bom && <span className="badge">BOM</span>}
          {dirty && <span className="badge badge-warn">未保存</span>}
        </div>
        <button type="button" className="btn btn-accent" disabled={!dirty} onClick={onSave}>
          <Save size={13} />
          <span>保存（Ctrl+S）</span>
        </button>
      </div>
      <div
        ref={hostRef}
        style={{ flex: 1, minHeight: 0, overflow: "hidden", background: "#fff" }}
      />
    </div>
  );
}
