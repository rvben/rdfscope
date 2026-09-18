const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  let provider, receive, change, dispose;
  const commands = new Map(), sent = [], writes = [], errors = [], sourceViews = [], executions = [];
  let destination;
  const uri = value => ({ path: value, toString: () => value, with: update => uri(update.path) });
  const vscode = {
    Uri: { joinPath: (base, ...parts) => uri(path.posix.join(base.path, ...parts)) },
    ViewColumn: { Beside: 2, Active: -1 },
    window: {
      visibleTextEditors: [],
      showTextDocument: async (...args) => sourceViews.push(args),
      registerCustomEditorProvider: (_, value) => { provider = value; return { dispose() {} }; },
      showSaveDialog: async () => destination,
      showOpenDialog: async () => undefined,
      showErrorMessage: message => errors.push(message),
      showInformationMessage: async () => {},
    },
    workspace: {
      onDidChangeTextDocument: callback => { change = callback; return { dispose() {} }; },
      fs: { readFile: async () => Buffer.from(JSON.stringify({ "index.html": { file: "assets/main.js" } })), writeFile: async (...args) => writes.push(args) },
    },
    commands: { executeCommand: async (...args) => executions.push(args), registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() {} }; } },
  };
  const panel = {
    active: true,
    reveal: () => { panel.revealed = true; },
    webview: {
      cspSource: 'https://webview.example',
      asWebviewUri: value => value,
      postMessage: async value => sent.push(value),
      onDidReceiveMessage: callback => { receive = callback; return { dispose() {} }; },
    },
    onDidDispose: callback => { dispose = callback; },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension.cjs'), 'utf8'), {
    module, Buffer,
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === './media/.vite/manifest.json') return { 'index.html': { file: 'assets/main.js' } };
      if (name === './webview.cjs') return require('../webview.cjs');
      return require(name);
    },
  });
  module.exports.activate({ extensionUri: uri('/extension'), subscriptions: [] });
  const document = { uri: uri('/workspace/source.ttl'), getText: () => 'unsaved RDF source' };
  return {
    async open() { await provider.resolveCustomTextEditor(document, panel); },
    receive: message => receive(message), change: () => change({ document }),
    setDestination: value => { destination = value ? uri(value) : undefined; },
    dispose: () => dispose(), panel, document, sent, writes, errors, vscode, commands, sourceViews, executions,
  };
}

test('loads current editor text only after ready; keeps filesystem access limited to media', async () => {
  const h = harness();
  await h.open();
  assert.equal(h.sent.length, 0);
  assert.equal(h.panel.webview.options.localResourceRoots[0].path, '/extension/media');
  await h.receive({ type: 'ready' });
  assert.equal(h.sent[0].content, 'unsaved RDF source');
  assert.equal(h.sent[0].name, 'source.ttl');
  await h.receive({ type: 'ready' });
  assert.equal(h.sent.length, 1);
  h.change();
  assert.equal(h.sent[1].type, 'sourceChanged');
  assert.equal(h.writes.length, 0);
  h.dispose();
});

test('export requires save destination, rejects source overwrite, and writes selected file', async () => {
  const h = harness();
  await h.open();
  const message = { type: 'export', name: 'graph.svg', content: '<svg />' };
  await h.receive(message);
  assert.equal(h.writes.length, 0);
  h.setDestination('/workspace/source.ttl');
  await h.receive(message);
  assert.equal(h.writes.length, 0);
  assert.match(h.sent.at(-1).error, /cannot overwrite the source/);
  assert.equal(h.sent.at(-1).status, 'error');
  h.setDestination('/workspace/graph.svg');
  await h.receive(message);
  assert.equal(h.writes[0][0].path, '/workspace/graph.svg');
  assert.equal(h.writes[0][1].toString(), '<svg />');
  assert.equal(h.sent.at(-1).status, 'saved');
  await h.receive({ ...message, name: '../graph.svg' });
  assert.equal(h.writes.length, 1);
  h.dispose();
});

test('Open Source reuses the visible text editor rather than adding another split', async () => {
  const h = harness();
  await h.open();
  h.vscode.window.visibleTextEditors = [{ document: h.document, viewColumn: 1 }];
  await h.commands.get('rdfscope.source')();
  assert.equal(h.sourceViews[0][1].viewColumn, 1);
  h.vscode.window.visibleTextEditors = [];
  await h.commands.get('rdfscope.source')();
  assert.equal(h.sourceViews[1][1].viewColumn, 2);
  h.dispose();
});

test('exploration uses the current pane by default and splitting is explicit', async () => {
  const h = harness();
  const other = { path: '/workspace/other.ttl', toString: () => '/workspace/other.ttl' };
  await h.commands.get('rdfscope.open')(other);
  assert.equal(h.executions[0][3], -1);
  await h.commands.get('rdfscope.openBeside')(other);
  assert.equal(h.executions[1][3], 2);
  await h.open();
  await h.commands.get('rdfscope.open')(h.document.uri);
  assert.equal(h.panel.revealed, true);
  assert.equal(h.executions.length, 2);
  h.dispose();
});

test('reload reads the current buffer without a modal, and oversized sources report an actionable error', async () => {
  const h = harness();
  await h.open();
  await h.receive({ type: 'ready' });
  h.document.getText = () => 'updated RDF source';
  await h.commands.get('rdfscope.reload')();
  assert.equal(h.sent.at(-1).content, 'updated RDF source');
  h.document.getText = () => 'x'.repeat(10 * 1024 * 1024 + 1);
  await h.receive({ type: 'reload' });
  assert.equal(h.sent.at(-1).type, 'loadError');
  assert.match(h.sent.at(-1).error, /10 MB/);
  h.dispose();
});
