import { createEngineWorker } from "./worker";

export const browserMode = true;
export const fileLimitMb = 10;

type Operation = {
  route: string;
  payload: Record<string, unknown>;
  bytes?: ArrayBuffer;
  filename?: string;
  snapshot?: string;
};

type Pending = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

class Engine {
  private worker: Worker | undefined;
  private ready: Promise<Worker>;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private stopped = false;

  constructor() {
    this.ready = createEngineWorker().then((worker) => {
      this.worker = worker;
      if (this.stopped) worker.terminate();
      worker.onmessage = ({
        data,
      }: MessageEvent<{ id: number; result: string; error?: string }>) => {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        pending.cleanup();
        if (data.error) pending.reject(new Error(data.error));
        else pending.resolve(data.result);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        this.stop(
          new Error(
            "The browser engine could not start. Reload the page, or try the installed app.",
          ),
        );
      };
      worker.onmessageerror = () =>
        this.stop(
          new Error(
            "The browser engine could not read a response. Reload the page.",
          ),
        );
      return worker;
    });
    void this.ready.catch((error: Error) => this.stop(error));
  }

  stop(error = new Error("Browser operation cancelled.")) {
    this.stopped = true;
    this.worker?.terminate();
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  call(
    operation: Operation,
    signal?: AbortSignal,
    timeout = 60_000,
  ): Promise<string> {
    if (this.stopped)
      return Promise.reject(
        new Error(
          "The browser session has stopped. Reload the page and reopen your file.",
        ),
      );
    if (signal?.aborted)
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(
        () =>
          this.stop(
            new Error(
              operation.route === "/query"
                ? "Query stopped after 30 seconds. Your dataset is unchanged; try a more selective query."
                : "The browser operation took too long. Reload and try a smaller dataset, or use the installed app.",
            ),
          ),
        timeout,
      );
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      void this.ready
        .then((worker) => {
          if (!this.pending.has(id) || this.stopped) return;
          worker.postMessage(
            { id, ...operation },
            operation.bytes ? [operation.bytes] : [],
          );
        })
        .catch((error: Error) => this.stop(error));
    });
  }
}

let engine: Engine | undefined;
let queryRunning = false;
export async function request(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  engine ??= new Engine();
  const url = new URL(path, "https://rdfscope.local");
  const payload: Record<string, unknown> =
    body && !(body instanceof FormData)
      ? (body as Record<string, unknown>)
      : Object.fromEntries(url.searchParams);
  if (typeof payload.limit === "string") payload.limit = Number(payload.limit);
  const operation: Operation = { route: url.pathname, payload };
  try {
    if (body instanceof FormData) {
      const file = body.get("file");
      if (!(file instanceof File)) throw new Error("Choose an RDF file.");
      if (file.size > fileLimitMb * 1024 * 1024)
        throw new Error(
          "Browser files are limited to 10 MB. Use the installed app for larger datasets.",
        );
      operation.bytes = await file.arrayBuffer();
      operation.filename = file.name;
    }
    let result: string;
    if (operation.route === "/query") {
      if (queryRunning)
        throw new Error("A query is already running. Wait for it to finish.");
      queryRunning = true;
      let queryEngine: Engine | undefined;
      try {
        // Run queries against a snapshot in a separate worker. Terminating a slow
        // query preserves the active store and leaves exploration responsive.
        operation.snapshot = await engine.call(
          { route: "/export", payload: {} },
          signal,
        );
        queryEngine = new Engine();
        const cancel = () =>
          queryEngine?.stop(new DOMException("Aborted", "AbortError"));
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          result = await queryEngine.call(operation, signal, 30_000);
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      } finally {
        queryEngine?.stop();
        queryRunning = false;
      }
    } else {
      result = await engine.call(operation, signal);
    }
    return new Response(result, {
      headers: {
        "Content-Type":
          operation.route === "/export"
            ? "application/n-quads"
            : "application/json",
      },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
