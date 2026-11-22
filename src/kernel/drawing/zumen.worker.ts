/// <reference lib="webworker" />

import { loadSync, type Request, type Session, type Zumen, ZumenError } from "@zumen-jp/zumen";

type InitMessage = {
  id: number;
  kind: "init";
  module: WebAssembly.Module;
};

type PushMessage = {
  id: number;
  kind: "push";
  name: string;
  data: ArrayBuffer;
};

type CallMessage = {
  id: number;
  kind: "call";
  request: Request;
  take: boolean;
};

type WorkerRequest = InitMessage | PushMessage | CallMessage;

let zumen: Zumen | null = null;
let session: Session | null = null;

function serializeError(error: unknown) {
  const err = error as { name?: string; message?: string };
  if (error instanceof ZumenError) {
    return {
      name: error.name,
      message: error.message,
      status: error.status,
      response: error.response,
      broken: zumen?.broken === true,
    };
  }
  return {
    name: err?.name ?? "Error",
    message: err?.message ?? String(error),
    broken: zumen?.broken === true,
  };
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.kind === "init") {
      zumen = loadSync(msg.module);
      session = zumen.open();
      self.postMessage({ id: msg.id, ok: true });
      return;
    }
    if (!session) {
      throw new Error("zumen ワーカーが初期化されていません。");
    }
    if (msg.kind === "push") {
      session.push(msg.name, new Uint8Array(msg.data));
      self.postMessage({ id: msg.id, ok: true });
      return;
    }
    if (msg.kind === "call") {
      const response = session.call(msg.request);
      const blobs = msg.take ? response.blobs.map((b) => session!.take(b.id)) : [];
      const transfers: ArrayBuffer[] = [];
      const ownedBlobs = blobs.map((blob) => {
        const copy = new Uint8Array(blob.byteLength);
        copy.set(blob);
        transfers.push(copy.buffer);
        return copy;
      });
      self.postMessage({ id: msg.id, ok: true, response, blobs: ownedBlobs }, transfers);
      return;
    }
    throw new Error("未対応のワーカー要求です。");
  } catch (error) {
    self.postMessage({ id: msg.id, ok: false, error: serializeError(error) });
  }
});
