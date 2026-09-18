// Acquire once and keep the host API private to this module.
type Host = { postMessage(message: unknown): void };
const host: Host | undefined =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
export const vscodeMode = !!host;
export type SourceStatus = {
  name: string;
  changed: boolean;
  dirty: boolean;
  error?: string;
};
export function vscodeAction(type: "open" | "reload" | "source") {
  host?.postMessage({ type });
}
export function saveToVscode(name: string, content: string): boolean {
  if (!host) return false;
  host.postMessage({ type: "export", name, content });
  return true;
}
export function connectVscode(
  onFile: (file: File) => Promise<void>,
  onNotice: (message: string, error?: boolean) => void,
  onSource: (source: SourceStatus) => void,
): () => void {
  if (!host) return () => {};
  let queue = Promise.resolve();
  let loaded = false;
  let latestVersion = 0;
  let latestDirty = false;
  let loadError: string | undefined;
  const receive = (event: MessageEvent) => {
    const message = event.data;
    if (
      message?.type === "file" &&
      typeof message.name === "string" &&
      typeof message.content === "string"
    ) {
      queue = queue
        .then(async () => {
          await onFile(new File([message.content], message.name));
          loaded = true;
          loadError = undefined;
          const changed =
            typeof message.version === "number" &&
            latestVersion > message.version;
          onSource({
            name: message.name,
            changed,
            dirty: changed ? latestDirty : message.dirty === true,
          });
        })
        .catch((error: Error) => {
          loadError = loaded ? undefined : error.message;
          onSource({
            name: message.name,
            changed: loaded,
            dirty: message.dirty === true,
            error: loadError,
          });
          onNotice(error.message, true);
        });
    } else if (message?.type === "loadError") {
      loadError = loaded ? undefined : message.error;
      onSource({
        name: message.name,
        changed: loaded,
        dirty: false,
        error: loadError,
      });
      onNotice(message.error, true);
    } else if (message?.type === "sourceChanged") {
      latestVersion = Math.max(latestVersion, Number(message.version) || 0);
      latestDirty = message.dirty === true;
      onSource({
        name: message.name,
        changed: true,
        dirty: message.dirty === true,
        error: loadError,
      });
    } else if (message?.type === "exportResult") {
      if (message.status === "saved") onNotice(`Saved ${message.name}`);
      else if (message.status === "error")
        onNotice(
          message.error ||
            "Could not save the export. Try another destination.",
          true,
        );
    }
  };
  window.addEventListener("message", receive);
  host.postMessage({ type: "ready" });
  return () => window.removeEventListener("message", receive);
}
