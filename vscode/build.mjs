import { cp, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
// Release builds rebuild the Rust engine and its dependency notices together.
if (!process.argv.includes('--reuse-engine')) {
  execFileSync('make', ['browser'], { cwd: root, stdio: 'inherit' });
}
const notices = await readFile(new URL('../web/dist-browser/THIRD_PARTY_LICENSES.txt', import.meta.url), 'utf8');
if (!notices.includes('Rust dependencies used to build the browser RDF engine')) {
  throw new Error('The browser build is missing Rust dependency notices. Run the full extension build before packaging.');
}
execFileSync('npm', ['run', 'build:vscode'], { cwd: `${root}/web`, stdio: 'inherit' });
await rm(new URL('./media', import.meta.url), { recursive: true, force: true });
await cp(new URL('../web/dist-vscode', import.meta.url), new URL('./media', import.meta.url), { recursive: true });
await cp(new URL('../web/dist-browser/THIRD_PARTY_LICENSES.txt', import.meta.url), new URL('./media/THIRD_PARTY_LICENSES.txt', import.meta.url));
await cp(new URL('../LICENSE', import.meta.url), new URL('./LICENSE', import.meta.url));
