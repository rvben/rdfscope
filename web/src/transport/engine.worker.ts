import init, {
  BrowserSession,
  query_snapshot,
} from "../../wasm/rdfscope_browser.js";

const ready = init();
let session: BrowserSession | undefined;
// Keep initialization and dataset replacements in the order they were requested.
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent) => {
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
