import init, {
  BrowserSession,
  query_snapshot,
} from "../../wasm/rdfscope_browser.js";

let initialize: ((bytes: ArrayBuffer) => void) | undefined;
const ready =
  import.meta.env.MODE === "vscode"
    ? new Promise<unknown>((resolve, reject) => {
        initialize = (bytes) => {
          void init({ module_or_path: bytes }).then(resolve, reject);
        };
      })
    : init();
let session: BrowserSession | undefined;
// Keep initialization and dataset replacements in the order they were requested.
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent) => {
  if (event.data?.type === "initialize" && initialize) {
    initialize(event.data.bytes);
    initialize = undefined;
    return;
  }
  queue = queue.then(async () => {
    const { id, route, payload, bytes, filename, snapshot } = event.data;
    try {
      await ready;
      let result: string;
      if (route === "/query") {
        const started = performance.now();
        const value = JSON.parse(
          query_snapshot(new TextEncoder().encode(snapshot), payload.query),
        );
        value.elapsed_ms = Math.round(performance.now() - started);
        result = JSON.stringify(value);
      } else {
        session ??= new BrowserSession();
        result =
          route === "/import"
            ? session.import_file(new Uint8Array(bytes), filename)
            : session.request(route, JSON.stringify(payload));
      }
      self.postMessage({ id, result });
    } catch (error) {
      self.postMessage({ id, error: String(error) });
    }
  });
};
