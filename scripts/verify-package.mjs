import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-package-"));
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw result.error ?? new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const [packed] = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--cache", path.join(scratch, "npm-cache"), "--pack-destination", scratch]));
  const target = path.join(scratch, "node_modules/@myfield/sdk");
  await fs.mkdir(target, { recursive: true });
  run("tar", ["-xzf", path.join(scratch, packed.filename), "-C", target, "--strip-components=1"]);
  await fs.writeFile(path.join(scratch, "package.json"), JSON.stringify({ type: "module" }));
  await fs.copyFile(path.join(root, "test/api-consumer.ts"), path.join(scratch, "consumer.ts"));
  run(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "consumer.ts"], scratch);
  const imported = await import(pathToFileURL(path.join(target, "dist/index.js")).href);
  assert.deepEqual(Object.keys(imported).sort(), ["ClientError", "NotConnectedError", "OfflineError", "createInstance"]);
  const instance = imported.createInstance({ appId: "package.example", namespace: "package-check", storage: "memory" });
  const bucket = instance.getBucket();
  await bucket.put("note:1", { markdown: "offline" });
  assert.equal((await bucket.get("note:1")).markdown, "offline");
  bucket.dispose();
  for (const name of ["types/index.d.ts", "docs/api/index.md", "docs/README.md", "docs/api.md", "docs/spec/bucket.md"]) {
    assert.ok(packed.files.some(file => file.path === name), `Missing or incorrectly cased package path: ${name}`);
    await fs.access(path.join(target, name));
  }
  run(process.execPath, [path.join(root, "scripts/verify-docs.mjs"), target]);
  assert.ok(!packed.files.some(file => /^(node_modules|\.api-build|test|config)\//.test(file.path)));
  console.log(`Verified ${packed.filename}: exports, consumer types, offline CRUD, docs and package links.`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
