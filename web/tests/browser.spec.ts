import { test as base, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// On the local macOS workspace use the user's bounded, disposable Chrome
// wrapper. CI uses Playwright's managed Chromium, never system Chrome.
const test = base.extend({
  browser: [
    async ({ playwright }, use) => {
      if (!process.env.HEADLESS_BROWSER_WRAPPER) {
        const browser = await playwright.chromium.launch();
        try {
          await use(browser);
        } finally {
          await browser.close();
        }
        return;
      }
      const proc = spawn(
        process.env.HEADLESS_BROWSER_WRAPPER,
        [
          "--remote-debugging-port=0",
          "--remote-debugging-address=127.0.0.1",
          "--user-agent=RDFscope-BrowserTest/0.1",
          "about:blank",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      const exited = once(proc, "exit");
      let browser:
        | Awaited<ReturnType<typeof playwright.chromium.connectOverCDP>>
        | undefined;
      try {
        const endpoint = await new Promise<string>((resolve, reject) => {
          let output = "";
          const timer = setTimeout(
            () => reject(new Error("Browser startup timed out")),
            20_000,
          );
          proc.stderr.on("data", (chunk) => {
            output += chunk;
            const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
            if (match) {
              clearTimeout(timer);
              resolve(match[1]);
            }
          });
          proc.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          proc.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Browser exited ${code}: ${output}`));
          });
        });
        browser = await playwright.chromium.connectOverCDP(endpoint);
        await use(browser);
      } finally {
        if (browser?.isConnected()) {
          try {
            const cdp = await browser.newBrowserCDPSession();
            await cdp.send("Browser.close");
          } catch {
            /* Already closed. */
          }
          await browser.close();
        } else proc.kill("SIGTERM");
        await exited;
      }
    },
    { scope: "worker" },
  ],
});

const rdf =
  '@prefix ex: <https://ex/> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . ex:g { ex:alice rdfs:label "Alice"@en; ex:knows ex:bob; ex:age 42 . ex:bob rdfs:label "Bob" . }';

async function openFile(
  page: import("@playwright/test").Page,
  name: string,
  text: string,
) {
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page.locator("dialog input[type=file]").setInputFiles({
    name,
    mimeType: "application/octet-stream",
    buffer: Buffer.from(text),
  });
}

async function runQuery(page: import("@playwright/test").Page, query: string) {
  await page.getByRole("button", { name: "SPARQL", exact: true }).click();
  await page.getByRole("textbox", { name: "SPARQL query" }).fill(query);
  await page.getByRole("button", { name: "Run query", exact: true }).click();
}

test("private file exploration, queries, exports and workspace restore", async ({
  page,
}) => {
  const errors: string[] = [],
    requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain(
    "wasm-unsafe-eval",
  );
  await expect(page.locator(".resource-heading h2")).toHaveText(
    "Knowledge graphs",
  );
  await expect(
    page.getByRole("button", { name: "Connect endpoint" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Trace", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Browse connections" }).click();
  await expect(page.locator(".connection")).toHaveCount(7);

  if (process.env.SCREENSHOT_DIR) {
    await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: resolve(process.env.SCREENSHOT_DIR, "browser-desktop.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    // Let the responsive drawer transition and graph framing settle for capture.
    await page.waitForTimeout(400);
    await expect(page.locator(".connection").first()).toBeInViewport();
    await page.screenshot({
      path: resolve(process.env.SCREENSHOT_DIR, "browser-mobile.png"),
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Open file", exact: true }).click();
    await expect(
      page.locator("dialog").getByRole("link", { name: "Get the app" }),
    ).toBeInViewport();
    await page.screenshot({
      path: resolve(process.env.SCREENSHOT_DIR, "browser-mobile-open.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({
      path: resolve(process.env.SCREENSHOT_DIR, "browser-desktop-open.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Close open dialog" }).click();
  }

  await openFile(page, "private.trig", rdf);
  await expect(page.locator("dialog")).not.toBeVisible();
  await expect(page.locator(".workspace-title h1")).toHaveText("private.trig");
  await expect(page.locator(".resource-heading h2")).toHaveText("Alice");
  await runQuery(
    page,
    "SELECT ?name WHERE { GRAPH <https://ex/g> { <https://ex/alice> <http://www.w3.org/2000/01/rdf-schema#label> ?name } }",
  );
  await expect(page.locator(".query-result tbody")).toContainText("Alice@en");
  await runQuery(page, "ASK { GRAPH ?g { ?s ?p ?o } }");
  await expect(page.locator(".boolean-result")).toHaveText("True");

  await openFile(page, "broken.ttl", "not turtle");
  await expect(page.locator("dialog")).toContainText("Could not parse");
  await expect(page.locator(".workspace-title h1")).toHaveText("private.trig");
  await page.getByRole("button", { name: "Close open dialog" }).click();
  await openFile(page, "too-large.ttl", " ".repeat(10 * 1024 * 1024 + 1));
  await expect(page.locator("dialog")).toContainText("Files up to 10 MB");
  await page.getByRole("button", { name: "Close open dialog" }).click();

  await page.locator(".export-menu summary").click();
  const rdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export RDF as N-Quads" }).click();
  const nquads = await readFile(
    (await (await rdfDownload).path()) as string,
    "utf8",
  );
  expect(nquads).toContain('"Alice"@en <https://ex/g>');

  await page.locator(".export-menu summary").click();
  const workspaceDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save workspace" }).click();
  const workspace = await readFile(
    (await (await workspaceDownload).path()) as string,
    "utf8",
  );
  expect(JSON.parse(workspace).nquads).toContain("https://ex/alice");
  await page.reload();
  await expect(page.locator(".workspace-title h1")).toHaveText(
    "The connected library",
  );
  await openFile(page, "saved.rdfscope.json", workspace);
  await expect(page.locator(".workspace-title h1")).toHaveText("private.trig");
  await runQuery(page, "ASK { GRAPH ?g { <https://ex/alice> ?p ?o } }");
  await expect(page.locator(".boolean-result")).toHaveText("True");

  expect(
    requests.filter(
      (url) =>
        url.includes("/api/") || !url.startsWith("http://127.0.0.1:4173/"),
    ),
  ).toEqual([]);
  expect(errors).toEqual([]);
});

test("a timed-out query leaves the active dataset usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".workspace-title h1")).toHaveText(
    "The connected library",
  );
  await openFile(
    page,
    "query.ttl",
    Array.from(
      { length: 500 },
      (_, i) => `<https://ex/s${i}> <https://ex/p> <https://ex/o> .`,
    ).join("\n"),
  );
  await expect(page.locator(".workspace-title h1")).toHaveText("query.ttl");
  await page.clock.install();
  const queryWorker = page.waitForEvent("worker");
  await runQuery(
    page,
    "SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o . ?a ?b ?c . ?d ?e ?f . ?g ?h ?i }",
  );
  await expect(
    page.getByRole("button", { name: "Running query…" }),
  ).toBeVisible();
  await queryWorker;
  // The UI timer terminates only the disposable query worker.
  await page.clock.runFor(31_000);
  await expect(page.locator(".query-error")).toContainText(
    "Query stopped after 30 seconds",
  );
  await runQuery(page, "ASK { ?s ?p ?o }");
  await page.clock.resume();
  await expect(page.locator(".boolean-result")).toHaveText("True");
});

test("all advertised RDF formats load in WebAssembly", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".workspace-title h1")).toHaveText(
    "The connected library",
  );
  const files = [
    ["data.ttl", '<https://ex/a> <https://ex/p> "Turtle" .'],
    ["data.trig", '<https://ex/g> { <https://ex/a> <https://ex/p> "TriG" . }'],
    ["data.nt", '_:a <https://ex/p> "N-Triples" .'],
    ["data.nq", '_:a <https://ex/p> "N-Quads" <https://ex/g> .'],
    [
      "data.rdf",
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:ex="https://ex/"><rdf:Description rdf:about="https://ex/a"><ex:p>XML</ex:p></rdf:Description></rdf:RDF>',
    ],
    [
      "data.jsonld",
      '{"@context":{"p":"https://ex/p"},"@id":"https://ex/a","p":"JSON-LD"}',
    ],
  ];
  for (const [name, text] of files) {
    await openFile(page, name, text);
    await expect(page.locator("dialog")).not.toBeVisible();
    await expect(page.locator(".workspace-title h1")).toHaveText(name);
    await runQuery(
      page,
      "ASK { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }",
    );
    await expect(page.locator(".boolean-result")).toHaveText("True");
  }
});
