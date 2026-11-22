// Chrome IndexedDB ストア（最近のフォルダーハンドル・会話履歴・テキスト変更差分・設定）。

import type { TextChangeRecord } from "../fs/types";

const DB_NAME = "zumen-editor-web";
const DB_VERSION = 1;

export type StoredWorkspaceHandle = {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  openedAt: number;
};

export type StoredChatSession = {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt: number;
  messages: unknown[];
  modelItems: unknown[];
};

export type AppPreferences = {
  model: string;
  paletteMode: "builtin" | "profile" | "none";
  proposalApprovalMode: "confirm" | "auto";
};

export const DEFAULT_PREFERENCES: AppPreferences = {
  model: "",
  paletteMode: "builtin",
  proposalApprovalMode: "confirm",
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB が利用できません。"));
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("handles")) {
          db.createObjectStore("handles", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("sessions")) {
          const store = db.createObjectStore("sessions", { keyPath: "id" });
          store.createIndex("by_workspace", "workspaceId", { unique: false });
        }
        if (!db.objectStoreNames.contains("textChanges")) {
          db.createObjectStore("textChanges", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("prefs")) {
          db.createObjectStore("prefs", { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB を開けませんでした。"));
    });
  }
  return dbPromise;
}

function txRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB 操作に失敗しました。"));
  });
}

export async function saveRecentHandle(record: StoredWorkspaceHandle): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction("handles", "readwrite");
    await txRequest(tx.objectStore("handles").put(record));
  } catch {
    // プライベートモード等で保存失敗しても動作は継続
  }
}

export async function listRecentHandles(): Promise<StoredWorkspaceHandle[]> {
  try {
    const db = await openDb();
    const tx = db.transaction("handles", "readonly");
    const all = (await txRequest(tx.objectStore("handles").getAll())) as StoredWorkspaceHandle[];
    return all.sort((a, b) => b.openedAt - a.openedAt).slice(0, 8);
  } catch {
    return [];
  }
}

export async function saveChatSession(session: StoredChatSession): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction("sessions", "readwrite");
    await txRequest(tx.objectStore("sessions").put(session));
  } catch {
    // ignore
  }
}

export async function listChatSessions(workspaceId: string): Promise<StoredChatSession[]> {
  try {
    const db = await openDb();
    const tx = db.transaction("sessions", "readonly");
    const idx = tx.objectStore("sessions").index("by_workspace");
    const all = (await txRequest(idx.getAll(workspaceId))) as StoredChatSession[];
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function deleteChatSession(id: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction("sessions", "readwrite");
    await txRequest(tx.objectStore("sessions").delete(id));
  } catch {
    // ignore
  }
}

export async function saveTextChangeRecord(record: TextChangeRecord): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction("textChanges", "readwrite");
    await txRequest(tx.objectStore("textChanges").put(record));
  } catch {
    // ignore
  }
}

export async function getTextChangeRecord(id: string): Promise<TextChangeRecord | null> {
  try {
    const db = await openDb();
    const tx = db.transaction("textChanges", "readonly");
    const res = (await txRequest(tx.objectStore("textChanges").get(id))) as
      | TextChangeRecord
      | undefined;
    return res ?? null;
  } catch {
    return null;
  }
}

export async function loadPreferences(): Promise<AppPreferences> {
  try {
    const db = await openDb();
    const tx = db.transaction("prefs", "readonly");
    const row = (await txRequest(tx.objectStore("prefs").get("app"))) as
      | { key: string; value: Partial<AppPreferences> }
      | undefined;
    return { ...DEFAULT_PREFERENCES, ...(row?.value ?? {}) };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export async function savePreferences(prefs: AppPreferences): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction("prefs", "readwrite");
    await txRequest(tx.objectStore("prefs").put({ key: "app", value: prefs }));
  } catch {
    // ignore
  }
}
