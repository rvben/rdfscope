// Preserve the notices for dependencies shipped in the embedded interface.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const lock = JSON.parse(readFileSync(resolve(web, "package-lock.json"), "utf8"));
const notices = ["Third-party notices for the RDFscope interface\n"];
for (const [path, entry] of Object.entries(lock.packages).sort()) {
  if (!path || entry.dev) continue;
  const directory = resolve(web, path);
  const pkg = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  const files = readdirSync(directory).filter((name) =>
    /^(licen[cs]e|copying|notice)(\.|$)/i.test(name),
  );
  if (!files.length) throw new Error(`Missing license notice for ${pkg.name}`);
  notices.push(`\n${pkg.name} ${pkg.version} (${entry.license ?? pkg.license})\n`);
  for (const name of files.sort()) {
    notices.push(readFileSync(resolve(directory, name), "utf8"));
  }
}
writeFileSync(resolve(web, process.argv[2] || "dist", "THIRD_PARTY_LICENSES.txt"), notices.join("\n"));
