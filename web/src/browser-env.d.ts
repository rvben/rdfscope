/// <reference types="vite/client" />

declare module "*rdfscope_browser.js" {
  export default function init(): Promise<unknown>;
  export class BrowserSession {
    constructor();
    import_file(bytes: Uint8Array, filename: string): string;
    request(route: string, payload: string): string;
    free(): void;
  }
  export function query_snapshot(nquads: Uint8Array, query: string): string;
}
