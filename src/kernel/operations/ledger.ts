import type { ActionKind, OperationCategory } from "./types";

export type OperationEntry = {
  id: string;
  title: string;
  category: OperationCategory;
  human: { actions: readonly string[] } | { none: string };
  agent: { tools: readonly string[] } | { action: ActionKind } | { none: string };
};

/**
 * UI（人間操作）とエージェント（OpenAI function tools / action_propose）の全操作台帳。
 * commit 分類の操作はエージェントに直接渡さず、必ず action_propose の確認の札を経由する。
 */
export const OPERATIONS: readonly OperationEntry[] = [
  {
    id: "drawing.open_and_tables",
    title: "図面を開き、空間・用紙・レイヤ・線種・スタイル・診断を読む",
    category: "read",
    human: { actions: ["drawing.open"] },
    agent: { tools: ["drawing_open", "drawing_tables"] },
  },
  {
    id: "drawing.entities",
    title: "図面の要素一覧・座標・属性・ハッシュを読む",
    category: "read",
    human: { actions: ["drawing.entities"] },
    agent: { tools: ["drawing_entities"] },
  },
  {
    id: "drawing.render",
    title: "図面の WebGPU シーンまたは PNG 画像を得る",
    category: "read",
    human: { actions: ["drawing.scene"] },
    agent: { tools: ["drawing_render"] },
  },
  {
    id: "drawing.check",
    title: "図面を公開プロファイル（CAD製図基準など）で照合する",
    category: "read",
    human: { actions: ["drawing.check"] },
    agent: { tools: ["drawing_check"] },
  },
  {
    id: "drawing.measure",
    title: "図面の 2 点距離・要素の長さ・周長・面積をコアで測る",
    category: "read",
    human: { actions: ["drawing.measure"] },
    agent: { tools: ["drawing_measure"] },
  },
  {
    id: "drawing.edit_and_propose",
    title: "図面の編集（人の操作・Undo/Redo）およびエージェントの変更案提出・履歴参照",
    category: "edit",
    human: { actions: ["drawing.userEdit", "drawing.undo", "drawing.redo"] },
    agent: { tools: ["drawing_propose", "drawing_history"] },
  },
  {
    id: "drawing.confirm_proposal",
    title: "エージェントが出した図面変更案を適用・却下する",
    category: "edit",
    human: { actions: ["drawing.applyProposal", "drawing.dismissProposal"] },
    agent: { none: "図面への適用と却下は利用者だけが判断して実行する。" },
  },
  {
    id: "drawing.create",
    title: "新しい空の DXF 図面を作成して保存する",
    category: "commit",
    human: { actions: ["drawing.create"] },
    agent: { action: "create_drawing" },
  },
  {
    id: "drawing.save",
    title: "図面の変更を控えを残して元ファイルへ上書き保存する",
    category: "commit",
    human: { actions: ["drawing.save"] },
    agent: { action: "save_drawing" },
  },
  {
    id: "drawing.export",
    title: "図面を DXF / SVG / PNG 形式で別ファイルへ書き出す",
    category: "commit",
    human: { actions: ["drawing.export"] },
    agent: { action: "export_drawing" },
  },
  {
    id: "view.state_and_focus",
    title: "開いているタブ・選択要素の参照、ファイル表示・要素フォーカス・レイヤ表示切替",
    category: "view",
    human: { actions: ["view.state", "view.focus", "view.open", "view.layers"] },
    agent: { tools: ["selection_get", "view_focus", "view_open", "view_layers"] },
  },
  {
    id: "files.list",
    title: "作業フォルダー内のファイルとフォルダーを一覧する",
    category: "read",
    human: { actions: ["files.list"] },
    agent: { tools: ["file_list"] },
  },
  {
    id: "files.read_text",
    title: "テキストファイルを文字コード（UTF-8・Shift_JIS・UTF-16）を判定して読む",
    category: "read",
    human: { actions: ["files.readText"] },
    agent: { tools: ["text_read"] },
  },
  {
    id: "files.write_text",
    title: "テキストファイルを元の文字コード・改行を保って編集・作成する（差分と復元つき）",
    category: "edit",
    human: { actions: ["files.writeText"] },
    agent: { tools: ["text_edit", "text_write"] },
  },
  {
    id: "files.revert_text_change",
    title: "エージェントが書き換えたテキストを元に戻す",
    category: "edit",
    human: { actions: ["files.revertTextChange"] },
    agent: { none: "テキスト変更の復元は利用者がチャット上の差分カードから行う。" },
  },
  {
    id: "files.search_text",
    title: "作業フォルダー内のテキストを文字コード横断で検索する",
    category: "read",
    human: { actions: ["files.search"] },
    agent: { tools: ["text_search"] },
  },
  {
    id: "files.create_folder",
    title: "新しいフォルダーを作る",
    category: "commit",
    human: { actions: ["files.mkdir"] },
    agent: { action: "create_folder" },
  },
  {
    id: "files.rename_entry",
    title: "ファイルやフォルダーの名前変更・移動を行う",
    category: "commit",
    human: { actions: ["files.rename"] },
    agent: { action: "rename_entry" },
  },
  {
    id: "files.delete_entry",
    title: "控えを残してファイルやフォルダーを削除する",
    category: "commit",
    human: { actions: ["files.delete"] },
    agent: { action: "delete_entry" },
  },
  {
    id: "files.convert_encoding",
    title: "テキストファイルの文字コード・BOM・改行コードを変換して保存する",
    category: "commit",
    human: { actions: ["files.convertEncoding"] },
    agent: { action: "convert_encoding" },
  },
  {
    id: "sheet.read",
    title: "表（.xlsx / .csv / .tsv）のシート一覧・セル・数式・結合セルを読む",
    category: "read",
    human: { actions: ["sheet.read"] },
    agent: { tools: ["sheet_read"] },
  },
  {
    id: "chat.ask_user",
    title: "エージェントから利用者に尋ねて回答を待つ",
    category: "view",
    human: { actions: ["chat.answerQuestion"] },
    agent: { tools: ["ask_user"] },
  },
  {
    id: "chat.confirm_action",
    title: "エージェントが出した確認の札（境界操作）を実行・却下する",
    category: "commit",
    human: { actions: ["action.execute", "action.dismiss"] },
    agent: { none: "確認の札の実行と却下は利用者だけが行う。" },
  },
];

export function checkOperationSymmetry(actual: {
  agentTools: readonly string[];
  actionKinds: readonly string[];
}): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const coveredTools = new Set<string>();
  const coveredActions = new Set<string>();

  for (const entry of OPERATIONS) {
    if (seenIds.has(entry.id)) {
      problems.push(`操作 ID が重複しています: ${entry.id}`);
    }
    seenIds.add(entry.id);

    if ("tools" in entry.agent) {
      if (entry.category === "commit") {
        problems.push(
          `${entry.id}: commit 分類にエージェント直接ツールは許可できません（action_propose を使う）。`,
        );
      }
      for (const toolName of entry.agent.tools) coveredTools.add(toolName);
    } else if ("action" in entry.agent) {
      if (entry.category !== "commit") {
        problems.push(`${entry.id}: action_propose は commit 分類にのみ使用します。`);
      }
      coveredActions.add(entry.agent.action);
      coveredTools.add("action_propose");
    }
  }

  const actualToolSet = new Set(actual.agentTools);
  for (const t of actual.agentTools) {
    if (!coveredTools.has(t)) problems.push(`OPERATIONS に未登録のツールがあります: ${t}`);
  }
  for (const t of coveredTools) {
    if (!actualToolSet.has(t)) problems.push(`OPERATIONS のツールが実装にありません: ${t}`);
  }

  const actualActionSet = new Set(actual.actionKinds);
  for (const k of actual.actionKinds) {
    if (!coveredActions.has(k)) problems.push(`OPERATIONS に未登録の確認の札があります: ${k}`);
  }
  for (const k of coveredActions) {
    if (!actualActionSet.has(k)) problems.push(`OPERATIONS の確認の札が実装にありません: ${k}`);
  }

  return problems;
}
