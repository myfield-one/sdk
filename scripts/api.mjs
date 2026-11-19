import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";

const root = fileURLToPath(new URL("../", import.meta.url));
const update = process.argv.includes("--update");
const build = process.argv.includes("--build");
if (update && build) throw new Error("Choose update or build, not both");
const scratch = path.join(root, ".api-build");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
if (JSON.stringify(Object.keys(pkg.exports)) !== JSON.stringify(["."])) throw new Error("Update extraction and consumer coverage for changed package exports");
const normalize = value => value.replace(/\r\n/g, "\n");

function run(tool, args) {
  const result = spawnSync(process.execPath, [path.join(root, "node_modules", tool), ...args], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw result.error ?? new Error(`${tool} failed`);
}
async function tree(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const nested = await Promise.all(entries.map(async entry => entry.isDirectory()
    ? (await tree(path.join(dir, entry.name))).map(file => path.join(entry.name, file)) : [entry.name]));
  return nested.flat().sort();
}
async function publish(from, to) {
  const files = await tree(from);
  if (!files.length) throw new Error(`No generated files in ${from}`);
  if (!update && JSON.stringify(files) !== JSON.stringify(await tree(to))) throw new Error(`${path.relative(root, to)} has missing or stale files; run pnpm api:update`);
  if (update) {
    await fs.rm(to, { recursive: true, force: true });
    await fs.mkdir(to, { recursive: true });
  }
  for (const file of files) {
    const content = normalize(await fs.readFile(path.join(from, file), "utf8"));
    const target = path.join(to, file);
    if (update) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    } else if (content !== normalize(await fs.readFile(target, "utf8"))) {
      throw new Error(`${path.relative(root, target)} is stale; run pnpm api:update`);
    }
  }
}

await fs.rm(scratch, { recursive: true, force: true });
if (update) await fs.mkdir(path.join(root, "etc"), { recursive: true });
run("typescript/bin/tsc", ["-p", "tsconfig.api.json"]);
const config = ExtractorConfig.loadFileAndPrepare(path.join(root, "config/api-extractor.json"));
if (!Extractor.invoke(config, { localBuild: update, showVerboseMessages: false }).succeeded) throw new Error("Public API extraction failed");
await publish(path.join(scratch, "types"), path.join(root, "types"));
if (!build) {
  run("typedoc/bin/typedoc", ["--options", "config/typedoc.json"]);
  await publish(path.join(scratch, "docs"), path.join(root, "docs/api"));
}
if (build) {
  const model = JSON.parse(await fs.readFile(path.join(scratch, "sdk.api.json"), "utf8"));
  const expected = model.members[0].members.filter(item => ["Class", "Function", "Variable", "Enum", "Namespace"].includes(item.kind)).map(item => item.name);
  const actual = Object.keys(await import(pathToFileURL(path.join(root, pkg.exports["."].import)).href));
  if (JSON.stringify([...new Set(expected)].sort()) !== JSON.stringify(actual.sort())) throw new Error("Runtime exports differ from public declarations");
}
console.log(update ? "Updated API report, declarations and reference docs." : "API checks passed without updating baselines.");
