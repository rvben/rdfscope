// Exercise the actual bundled frontend, worker and WASM under the webview CSP.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('../../web/node_modules/playwright');
const { html } = require('../webview.cjs');
const manifest = require('../media/.vite/manifest.json')['index.html'];
let origin;
let assetOrigin;
const assetServer = createServer(async (request, response) => {
  try {
    const file = request.url.match(/^\/media\/(assets\/[\w.-]+)$/)?.[1];
    if (!file) { response.writeHead(404).end(); return; }
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".css") ? "text/css" : "text/javascript");
    const data = await readFile(new URL(`../media/${file}`, import.meta.url));
    // VS Code resource fetches are unavailable inside the blob worker.
    response.end(file.includes("engine.worker-") ? Buffer.concat([Buffer.from("globalThis.fetch = () => Promise.reject(new Error(\"Worker resource fetch is unavailable\"));\n"), data]) : data);
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => assetServer.listen(0, "127.0.0.1", resolve));
assetOrigin = `http://127.0.0.1:${assetServer.address().port}`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(html({ cspSource: assetOrigin, asWebviewUri: uri => `${assetOrigin}${uri.path}` }, { path: '/media', with: value => value }, manifest));
      return;
    }
    const file = request.url.match(/^\/media\/(assets\/[\w.-]+)$/)?.[1];
    if (!file) { response.writeHead(404).end(); return; }
    const content = await readFile(new URL(`../media/${file}`, import.meta.url));
    response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(content);
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({ postMessage(message) {
      window.hostMessages.push(message);
      if (message.type === 'ready') setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'file', name: 'test.ttl', content: '@prefix ex: <https://example.org/> . ex:alice ex:knows ex:bob; ex:label "Alice"@en .',
      } })), 0);
    } });
  });
  page.setDefaultTimeout(10_000);
  await page.goto(origin);
  await page.getByText('Opened test.ttl', { exact: true }).waitFor();
  if (process.env.RDFSCOPE_VISUAL_QA) {
    const { mkdir } = await import('node:fs/promises');
    const folder = new URL('../../.impeccable/review/vscode/', import.meta.url);
    await mkdir(folder, { recursive: true });
    await page.setViewportSize({ width: 560, height: 600 });
    await page.locator('.react-flow__node').first().click();
    await page.getByRole('button', { name: 'SPARQL', exact: true }).click();
    await page.screenshot({ path: new URL(`${process.env.RDFSCOPE_VISUAL_QA}-query.png`, folder).pathname });
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.screenshot({ path: new URL(`${process.env.RDFSCOPE_VISUAL_QA}-wide.png`, folder).pathname });
    if (process.env.RDFSCOPE_VISUAL_QA !== 'before') {
      await page.addStyleTag({ content: `body { --vscode-editor-background:#1f1f1f; --vscode-editor-foreground:#cccccc; --vscode-descriptionForeground:#9d9d9d; --vscode-panel-border:#333333; --vscode-button-background:#0078d4; --vscode-button-hoverBackground:#026ec1; --vscode-button-foreground:#ffffff; --vscode-focusBorder:#007fd4; --vscode-list-hoverBackground:#2a2d2e; --vscode-input-background:#313131; --vscode-input-border:#3c3c3c; --vscode-textLink-foreground:#4daafc; --vscode-editorLineNumber-foreground:#8a8a8a; --vscode-editor-font-size:12px; }` });
      await page.evaluate(() => document.body.classList.add('vscode-dark'));
      await page.setViewportSize({ width: 560, height: 600 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: new URL(`${process.env.RDFSCOPE_VISUAL_QA}-dark.png`, folder).pathname });
    }
  }
  assert.equal(await page.getByRole('link', { name: 'Install RDFscope' }).count(), 0);
  await page.getByRole('button', { name: 'SPARQL', exact: true }).click();
  assert.equal(await page.locator('.inspector').count(), 0);
  for (const [width, height] of [[360, 320], [560, 600], [800, 500], [1280, 760]]) {
    await page.setViewportSize({ width, height });
    const button = await page.getByRole('button', { name: 'Run query', exact: true }).boundingBox();
    assert.ok(button && button.y > 0 && button.y + button.height < height, `Run query must be visible without scrolling at ${width}x${height}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  }
  await page.setViewportSize({ width: 560, height: 600 });
  await page.getByRole('textbox', { name: 'SPARQL query' }).fill('SELECT ?name WHERE { <https://example.org/alice> <https://example.org/label> ?name }');
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await page.getByRole('cell', { name: /Alice/ }).waitFor();
  await page.getByRole('textbox', { name: 'SPARQL query' }).fill('SELECT ?n WHERE { VALUES ?n { ' + Array.from({ length: 150 }, (_, i) => i).join(' ') + ' } }');
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await page.locator('.result-heading > span').filter({ hasText: '150 results' }).waitFor();
  await page.locator('.query-panel').evaluate(panel => { panel.scrollTop = panel.scrollHeight; });
  const pinnedRun = await page.getByRole('button', { name: 'Run query', exact: true }).boundingBox();
  assert.ok(pinnedRun.y < 160, 'Run query must stay visible while scrolling long results');
  await page.locator('.query-panel').evaluate(panel => { panel.scrollTop = 0; });
  await page.getByRole('textbox', { name: 'SPARQL query' }).fill('SELECT ?person WHERE { VALUES ?person { <https://example.org/alice> } }');
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await page.locator('.query-result .term-link').first().click();
  await page.getByRole('button', { name: 'Close inspector', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'SPARQL query' }).count(), 1, 'Inspecting a result must keep the query open');
  const content = await page.locator('.view-content').boundingBox();
  const main = await page.locator('.main-content').boundingBox();
  assert.equal(Math.round(content.height), Math.round(main.height), 'Inspector must not split the query into two halves');
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await page.getByRole('textbox', { name: 'SPARQL query' }).fill('SELECT ?name WHERE { <https://example.org/alice> <https://example.org/label> ?name }');
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await page.getByRole('cell', { name: /Alice/ }).waitFor();
  await page.locator('.export-menu summary').click();
  await page.getByRole('button', { name: 'Save workspace' }).click();
  await page.waitForFunction(() => window.hostMessages.some(message => message.type === 'export'));
  const exported = await page.evaluate(() => window.hostMessages.find(message => message.type === 'export'));
  assert.equal(exported.name, 'workspace.rdfscope.json');
  assert.match(JSON.parse(exported.content).nquads, /Alice/);
  assert.equal(await page.getByText('Saved workspace.rdfscope.json', { exact: true }).count(), 0);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'exportResult', status: 'saved', name: 'workspace.rdfscope.json' } })));
  await page.getByText('Saved workspace.rdfscope.json', { exact: true }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'sourceChanged', name: 'test.ttl', dirty: false, version: 2 } })));
  await page.getByText('Source changed', { exact: true }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'file', name: 'broken.ttl', content: 'not valid turtle' } })));
  await page.locator('.toast.error').waitFor();
  // Failed import must preserve the active dataset.
  await page.getByRole('button', { name: 'SPARQL', exact: true }).click();
  await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await page.getByRole('cell', { name: /Alice/ }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'file', name: 'new.ttl', content: '<https://example.org/new> <https://example.org/label> "New dataset" .' } })));
  await page.getByText('Opened new.ttl', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: cross-origin assets, blob workers, CSP, WASM, initial file, SPARQL, workspace export, source notice, failed import preservation, reload, full-height query, pinned Run button, result inspection, save acknowledgment');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => assetServer.close(resolve));
}
