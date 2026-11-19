import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkExactPath } from "./lib/docs-path.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const root = process.argv[2] ? path.resolve(process.argv[2]) : project;
async function markdown(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? markdown(path.join(dir, entry.name)) : entry.name.endsWith(".md") ? [path.join(dir, entry.name)] : []));
  return nested.flat();
}
const files = [path.join(root, "README.md"), ...await markdown(path.join(root, "docs"))];
const examples = [];
const slug = text => text.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
for (const file of files) {
  const source = await fs.readFile(file, "utf8");
  const generated = file.startsWith(path.join(root, "docs/api") + path.sep);
  for (const [, target] of source.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    if (/^[a-z]+:/i.test(target)) continue;
    const [pathname, anchor] = target.split("#");
    const resolved = pathname ? path.resolve(path.dirname(file), decodeURIComponent(pathname)) : file;
    await checkExactPath(root, resolved).catch(cause => {
      throw new Error(`Broken or incorrectly cased link in ${path.relative(root, file)}: ${target}`, { cause });
    });
    if (anchor && !generated && resolved.endsWith(".md") && !resolved.startsWith(path.join(root, "docs/api") + path.sep)) {
      const content = await fs.readFile(resolved, "utf8");
      const headings = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => slug(match[1]));
      if (!headings.includes(decodeURIComponent(anchor))) throw new Error(`Missing anchor in ${file}: ${target}`);
    }
  }
  if (file === path.join(root, "README.md")) {
    for (const [, code] of source.matchAll(/^```ts\n([\s\S]*?)^```/gm)) examples.push(code);
  }
}
const scratch = path.join(root, ".api-build", "examples");
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });
const samples = [];
for (const [index, code] of examples.entries()) {
  const file = path.join(scratch, `example-${index}.ts`);
  await fs.writeFile(file, code + "\nexport {};\n");
  samples.push(file);
}
if (!samples.length) throw new Error("No checked TypeScript documentation examples found");
const result = spawnSync(process.execPath, [path.join(project, "node_modules/typescript/bin/tsc"),
  "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", ...samples],
{ cwd: root, stdio: "inherit" });
if (result.status !== 0) throw result.error ?? new Error("Documentation examples failed public typechecking");
console.log(`Checked ${files.length} Markdown files and ${samples.length} public-entry examples.`);
