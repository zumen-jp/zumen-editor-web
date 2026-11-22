import type { AgentInputItem } from "@openai/agents";

/**
 * SIWC の `store: false` 制約下では毎ターン全会話履歴を送信するため、
 * 古いターンの図面レンダリング PNG（base64）が蓄積するとペイロードが肥大化する。
 * 直近 `maxRetainedImages` 枚だけ生画像を保持し、それより古い画像は要約テキストへ置換する。
 */
export function pruneOldImagesFromInputItems(
  items: readonly AgentInputItem[],
  maxRetainedImages = 2,
): AgentInputItem[] {
  let seenImages = 0;
  const out = new Array<AgentInputItem>(items.length);

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    out[i] = pruneItem(item, () => {
      seenImages += 1;
      return seenImages <= maxRetainedImages;
    });
  }
  return out;
}

function pruneItem(item: AgentInputItem, keepNextImage: () => boolean): AgentInputItem {
  if (!item || typeof item !== "object") return item;
  const record = item as Record<string, unknown>;

  // function_call_result の output が配列（テキスト + 画像）のケース
  if (record.type === "function_call_result" && Array.isArray(record.output)) {
    const nextOutput = pruneContentArray(record.output, keepNextImage);
    return { ...record, output: nextOutput } as AgentInputItem;
  }

  // function_call_result の output が単一画像オブジェクトのケース
  if (
    record.type === "function_call_result" &&
    record.output &&
    typeof record.output === "object" &&
    (record.output as { type?: unknown }).type === "image"
  ) {
    if (keepNextImage()) return item;
    return {
      ...record,
      output: {
        type: "text",
        text: "[省略: 過去ターンの図面画像。再確認が必要なら drawing_render を呼び出してください]",
      },
    } as AgentInputItem;
  }

  // user / assistant メッセージの content 配列に input_image があるケース
  if (Array.isArray(record.content)) {
    const nextContent = pruneContentArray(record.content, keepNextImage);
    return { ...record, content: nextContent } as AgentInputItem;
  }

  return item;
}

function pruneContentArray(parts: readonly unknown[], keepNextImage: () => boolean): unknown[] {
  const result = new Array<unknown>(parts.length);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part && typeof part === "object") {
      const type = (part as { type?: unknown }).type;
      if (type === "image" || type === "input_image") {
        if (keepNextImage()) {
          result[i] = part;
        } else {
          result[i] =
            type === "input_image"
              ? {
                  type: "input_text",
                  text: "[省略: 過去ターンの画像]",
                }
              : {
                  type: "text",
                  text: "[省略: 過去ターンの図面画像。再確認が必要なら drawing_render を呼び出してください]",
                };
        }
        continue;
      }
    }
    result[i] = part;
  }
  return result;
}
