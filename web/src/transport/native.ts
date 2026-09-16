export const browserMode = false;
export const fileLimitMb = 64;

export function request(path: string, body?: unknown, signal?: AbortSignal) {
  return fetch(
    "/api" + path,
    body === undefined
      ? { signal }
      : {
          signal,
          method: "POST",
          headers:
            body instanceof FormData
              ? { "x-rdfscope-request": "1" }
              : {
                  "Content-Type": "application/json",
                  "x-rdfscope-request": "1",
                },
          body: body instanceof FormData ? body : JSON.stringify(body),
        },
  );
}
