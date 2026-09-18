const crypto = require('node:crypto');

const MAX_BYTES = 10 * 1024 * 1024;
function validateExport(message) {
  if (!message || message.type !== 'export' || typeof message.name !== 'string' ||
      typeof message.content !== 'string' || Buffer.byteLength(message.content) > 64 * 1024 * 1024) return false;
  return /^[\w.-]+$/.test(message.name) && /\.(json|nq|svg)$/.test(message.name);
}
function html(webview, mediaUri, manifest) {
  const nonce = crypto.randomBytes(18).toString('base64');
  const asset = (file) => {
    if (!/^assets\/[\w.-]+$/.test(file)) throw new Error('Invalid webview asset path');
    return webview.asWebviewUri(mediaUri.with({ path: `${mediaUri.path}/${file}` })).toString();
  };
  const escape = (value) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const policy = `default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource}; connect-src ${webview.cspSource}; worker-src ${webview.cspSource} blob:;`;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escape(policy)}">${(manifest.css || []).map(file => `<link rel="stylesheet" href="${escape(asset(file))}">`).join('')}<title>RDFscope</title></head><body class="rdfscope-vscode"><div id="root"></div><script nonce="${nonce}" type="module" src="${escape(asset(manifest.file))}"></script></body></html>`;
}
module.exports = { MAX_BYTES, validateExport, html };
