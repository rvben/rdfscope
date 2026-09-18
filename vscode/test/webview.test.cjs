const { test } = require('node:test');
const assert = require('node:assert/strict');
const { html, validateExport } = require('../webview.cjs');
const manifest = require('../package.json');

test('exports accept supported files and reject path traversal and malformed messages', () => {
  for (const name of ['workspace.rdfscope.json', 'graph.svg', 'dataset.nq']) {
    assert.equal(validateExport({ type: 'export', name, content: 'data' }), true);
  }
  for (const name of ['../source.ttl', '/tmp/graph.svg', 'x.exe', 'x.svg"', '']) {
    assert.equal(validateExport({ type: 'export', name, content: 'data' }), false);
  }
  assert.equal(validateExport(null), false);
  assert.equal(validateExport({ type: 'export', name: 'x.svg', content: {} }), false);
});

test('webview restricts resources, enables WASM workers, and uses a fresh nonce', () => {
  const webview = { cspSource: 'https://webview.example', asWebviewUri: uri => `https://webview.example${uri.path}` };
  const uri = { path: '/media', with: value => value };
  const entry = { file: 'assets/main.js', css: ['assets/main.css'] };
  const first = html(webview, uri, entry);
  assert.match(first, /default-src 'none'/);
  assert.match(first, /wasm-unsafe-eval/);
  assert.match(first, /worker-src https:\/\/webview.example blob:/);
  assert.match(first, /src="https:\/\/webview.example\/media\/assets\/main.js"/);
  assert.notEqual(first, html(webview, uri, entry));
  assert.throws(() => html(webview, uri, { file: '../injected.js' }));
});

test('RDF explorer remains optional and supports all advertised RDF extensions', () => {
  const editor = manifest.contributes.customEditors[0];
  assert.equal(editor.priority, 'option');
  for (const extension of ['ttl', 'rdf', 'trig', 'nt', 'nq', 'jsonld']) {
    assert.ok(editor.selector.some(item => item.filenamePattern === `*.${extension}`));
  }
});
