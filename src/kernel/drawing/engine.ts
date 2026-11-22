import {
  type Diagnostic,
  load,
  type Request,
  type Response,
  type ResultOf,
  type Session,
  type Zumen,
  ZumenError,
} from "@zumen-jp/zumen";

export class ZumenCallError extends Error {
  constructor(
    readonly status: string,
    readonly diagnostics: Diagnostic[],
    message: string,
    readonly response?: Response,
  ) {
    super(message);
    this.name = "ZumenCallError";
  }
}

export type ZumenCallResult<R extends Request> = {
  response: Response<ResultOf<R>> & { result: ResultOf<R> };
  blobs: Uint8Array[];
};

export interface ZumenSessionHandle {
  readonly stopped: boolean;
  push(name: string, data: Uint8Array, timeoutMs?: number): Promise<void>;
  call<R extends Request>(
    request: R,
    options?: { take?: boolean; timeoutMs?: number },
  ): Promise<ZumenCallResult<R>>;
  terminate(): Promise<void>;
}

export interface ZumenEngineFactory {
  createSession(): Promise<ZumenSessionHandle>;
}

type WorkerReply =
  | { id: number; ok: true; response?: Response; blobs?: Uint8Array[] }
  | {
      id: number;
      ok: false;
      error: {
        name: string;
        message: string;
        status?: string;
        response?: Response;
        broken: boolean;
      };
    };

const DEFAULT_TIMEOUT_MS = 120_000;

class BrowserZumenWorkerSession implements ZumenSessionHandle {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    {
      resolve: (reply: Extract<WorkerReply, { ok: true }>) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private serial = 0;
  private stopError: Error | null = null;

  private constructor(worker: Worker) {
    this.worker = worker;
    this.worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
      this.onReply(event.data);
    });
    this.worker.addEventListener("error", (event) => {
      this.abortAll(new Error(`図面ワーカーが異常終了しました: ${event.message}`));
      this.worker.terminate();
    });
  }

  static async create(compiledModule: WebAssembly.Module): Promise<BrowserZumenWorkerSession> {
    const worker = new Worker(new URL("./zumen.worker.ts", import.meta.url), { type: "module" });
    const session = new BrowserZumenWorkerSession(worker);
    await session.send({ kind: "init", module: compiledModule }, [], 30_000);
    return session;
  }

  get stopped(): boolean {
    return this.stopError !== null;
  }

  async push(name: string, data: Uint8Array, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    await this.send({ kind: "push", name, data: copy.buffer }, [copy.buffer], timeoutMs);
  }

  async call<R extends Request>(
    request: R,
    options?: { take?: boolean; timeoutMs?: number },
  ): Promise<ZumenCallResult<R>> {
    const reply = await this.send(
      { kind: "call", request, take: options?.take === true },
      [],
      options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const response = reply.response as Response<ResultOf<R>> | undefined;
    if (!response || response.result === undefined) {
      throw new ZumenCallError(
        "invalid",
        response?.diagnostics ?? [],
        "zumen の応答に結果がありません。",
      );
    }
    return {
      response: response as ZumenCallResult<R>["response"],
      blobs: reply.blobs ?? [],
    };
  }

  async terminate(): Promise<void> {
    this.abortAll(new Error("図面ワーカーを閉じました。"));
    this.worker.terminate();
  }

  private send(
    payload: Record<string, unknown>,
    transfer: Transferable[],
    timeoutMs: number,
  ): Promise<Extract<WorkerReply, { ok: true }>> {
    if (this.stopError) return Promise.reject(this.stopError);
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => {
        this.abortAll(new Error("図面の処理が時間切れ（120 秒）になったため停止しました。"));
        this.worker.terminate();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ id, ...payload }, transfer);
      } catch (error) {
        this.finish(id)?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private finish(id: number) {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    return entry;
  }

  private onReply(reply: WorkerReply): void {
    const entry = this.finish(reply.id);
    if (reply.ok) {
      entry?.resolve(reply);
      return;
    }
    const err = reply.error;
    entry?.reject(
      err.status
        ? new ZumenCallError(err.status, err.response?.diagnostics ?? [], err.message, err.response)
        : new Error(err.message),
    );
    if (err.broken) {
      this.abortAll(new Error("図面エンジンの内部エラーによりワーカーを終了しました。"));
      this.worker.terminate();
    }
  }

  private abortAll(reason: Error): void {
    if (this.stopError) return;
    this.stopError = reason;
    for (const id of [...this.pending.keys()]) {
      this.finish(id)?.reject(reason);
    }
  }
}

/**
 * Chrome 専用 Web Worker ファクトリ。コンパイル済み WebAssembly.Module を 1 回だけ生成して共有する。
 */
export class BrowserZumenEngineFactory implements ZumenEngineFactory {
  private readonly wasmUrl: string;
  private modulePromise: Promise<WebAssembly.Module> | null = null;

  constructor(wasmUrl = "/assets/wasm/zumen_abi1_drawing.wasm") {
    this.wasmUrl = wasmUrl;
  }

  private compileOnce(): Promise<WebAssembly.Module> {
    if (!this.modulePromise) {
      this.modulePromise = (async () => {
        const res = await fetch(this.wasmUrl);
        if (!res.ok) {
          throw new Error(`zumen WASM を取得できませんでした（HTTP ${res.status}）。`);
        }
        if (typeof WebAssembly.compileStreaming === "function") {
          try {
            return await WebAssembly.compileStreaming(res.clone());
          } catch {
            // MIME type 等で失敗した場合は ArrayBuffer 経由へフォールバック
          }
        }
        return WebAssembly.compile(await res.arrayBuffer());
      })().catch((err) => {
        this.modulePromise = null;
        throw err;
      });
    }
    return this.modulePromise;
  }

  async createSession(): Promise<ZumenSessionHandle> {
    const mod = await this.compileOnce();
    return BrowserZumenWorkerSession.create(mod);
  }
}

/**
 * 単体テスト・非 Worker 環境向けの直接 WASM セッション実装。
 */
export class DirectZumenEngineFactory implements ZumenEngineFactory {
  private zumenPromise: Promise<Zumen> | null = null;

  constructor(private readonly loadWasmBytes: () => Promise<Uint8Array>) {}

  private getZumen(): Promise<Zumen> {
    if (!this.zumenPromise) {
      this.zumenPromise = this.loadWasmBytes().then((bytes) => load(bytes));
    }
    return this.zumenPromise;
  }

  async createSession(): Promise<ZumenSessionHandle> {
    const zumen = await this.getZumen();
    const session: Session = zumen.open();
    let closed = false;
    return {
      get stopped() {
        return closed || zumen.broken;
      },
      async push(name, data) {
        session.push(name, data);
      },
      async call<R extends Request>(request: R, options?: { take?: boolean }) {
        try {
          const response = session.call(request);
          const blobs = options?.take ? response.blobs.map((b) => session.take(b.id)) : [];
          if (response.result === undefined) {
            throw new ZumenCallError(
              "invalid",
              response.diagnostics ?? [],
              "zumen の応答に結果がありません。",
            );
          }
          return {
            response: response as ZumenCallResult<R>["response"],
            blobs,
          };
        } catch (error) {
          if (error instanceof ZumenError) {
            throw new ZumenCallError(
              error.status,
              error.response?.diagnostics ?? [],
              error.message,
              error.response,
            );
          }
          throw error;
        }
      },
      async terminate() {
        if (!closed) {
          closed = true;
          session.close();
        }
      },
    };
  }
}
