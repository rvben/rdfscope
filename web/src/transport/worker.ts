import wasmUrl from "../../wasm/rdfscope_browser_bg.wasm?url";
import workerUrl from "./engine.worker.ts?worker&url";

export async function createEngineWorker(): Promise<Worker> {
  const url = new URL(workerUrl, import.meta.url);
  if (import.meta.env.MODE !== "vscode")
    return new Worker(url, { type: "module" });

  // VS Code serves assets from a different origin than the webview document.
  // Workers must use blob URLs. The bundled worker has no module imports;
  // preserve its original asset base so WASM resolves outside the blob URL.
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not load the RDF engine worker.");
  const source = (await response.text()).replaceAll(
    "import.meta.url",
    JSON.stringify(url.href),
  );
  const blob = URL.createObjectURL(
    new Blob([source], { type: "text/javascript" }),
  );
  try {
    const wasm = await fetch(new URL(wasmUrl, import.meta.url));
    if (!wasm.ok) throw new Error("Could not load the RDF WebAssembly engine.");
    const bytes = await wasm.arrayBuffer();
    const worker = new Worker(blob, { type: "module" });
    // Blob workers cannot use VS Code's resource service worker directly.
    worker.postMessage({ type: "initialize", bytes }, [bytes]);
    return worker;
  } finally {
    URL.revokeObjectURL(blob);
  }
}
