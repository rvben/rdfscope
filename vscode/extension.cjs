const vscode = require('vscode');
const path = require('node:path');
const { MAX_BYTES, validateExport, html } = require('./webview.cjs');

function activate(context) {
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const panels = new Map();
  const report = (error) => vscode.window.showErrorMessage(`RDFscope: ${error.message || error}`);
  const active = () => [...panels.values()].find(entry => entry.panel.active);
  const open = async (uri, beside = false, choose = false) => {
    try {
      if (!choose) uri ||= vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'RDF and workspaces': ['ttl', 'rdf', 'trig', 'nt', 'nq', 'jsonld', 'json'] } });
        uri = selected?.[0];
      }
      if (!uri) return;
      const existing = [...panels.values()].find(entry => entry.document.uri.toString() === uri.toString());
      if (existing) { existing.panel.reveal(); return; }
      const column = beside ? vscode.ViewColumn.Beside : active()?.panel.viewColumn ?? vscode.ViewColumn.Active;
      await vscode.commands.executeCommand('vscode.openWith', uri, 'rdfscope.explorer', column);
    } catch (error) { report(error); }
  };
  const source = async (entry = active()) => {
    if (!entry) return;
    const visible = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === entry.document.uri.toString());
    await vscode.window.showTextDocument(entry.document, { viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside, preview: false });
  };
  const provider = {
    async resolveCustomTextEditor(document, panel) {
      panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
      const entry = { panel, document, ready: false };
      panels.set(panel, entry);
      const load = async () => {
        try {
          const content = document.getText();
          if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Files up to 10 MB are supported by the extension. Use the standalone app for larger files.');
          await panel.webview.postMessage({ type: 'file', name: path.basename(document.uri.path), content, dirty: document.isDirty, version: document.version });
        } catch (error) {
          await panel.webview.postMessage({ type: 'loadError', name: path.basename(document.uri.path), error: error.message });
        }
      };
      entry.load = load;
      const subscriptions = [
        panel.webview.onDidReceiveMessage(async message => {
          try {
            if (message?.type === 'ready' && !entry.ready) {
              entry.ready = true;
              await load();
            } else if (message?.type === 'open') {
              await open(undefined, false, true);
            } else if (message?.type === 'source') {
              await source(entry);
            } else if (message?.type === 'reload') {
              await load();
            } else if (validateExport(message)) {
              try {
                const destination = await vscode.window.showSaveDialog({
                  defaultUri: vscode.Uri.joinPath(document.uri, '..', message.name),
                  saveLabel: 'Save RDFscope export',
                });
                if (!destination) {
                  await panel.webview.postMessage({ type: 'exportResult', name: message.name, status: 'cancelled' });
                  return;
                }
                if (destination.toString() === document.uri.toString()) throw new Error('Choose a different file; exports cannot overwrite the source.');
                await vscode.workspace.fs.writeFile(destination, Buffer.from(message.content, 'utf8'));
                await panel.webview.postMessage({ type: 'exportResult', name: message.name, status: 'saved' });
              } catch (error) {
                await panel.webview.postMessage({ type: 'exportResult', name: message.name, status: 'error', error: error.message });
              }
            }
          } catch (error) { report(error); }
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
          if (event.document.uri.toString() === document.uri.toString()) {
            void panel.webview.postMessage({ type: 'sourceChanged', name: path.basename(document.uri.path), dirty: document.isDirty, version: document.version });
          }
        }),
      ];
      panel.onDidDispose(() => {
        panels.delete(panel);
        subscriptions.forEach(subscription => subscription.dispose());
      });
      // Read per editor so a development rebuild cannot leave cached asset paths.
      const manifest = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, '.vite', 'manifest.json'))).toString('utf8'))['index.html'];
      panel.webview.html = html(panel.webview, media, manifest);
    },
  };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('rdfscope.explorer', provider, {
      webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('rdfscope.open', uri => open(uri)),
    vscode.commands.registerCommand('rdfscope.openBeside', uri => open(uri, true)),
    vscode.commands.registerCommand('rdfscope.reload', () => active()?.load()),
    vscode.commands.registerCommand('rdfscope.source', () => source()),
  );
}
module.exports = { activate };
