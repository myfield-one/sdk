import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);

test("API checks reject drift without accepting baselines and updates are repeatable", { timeout: 180000 }, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-api-check-"));
  try {
    for (const entry of ["src", "config", "types", "etc", "docs/api", "package.json", "tsconfig.json", "tsconfig.api.json", "scripts/api.mjs"]) {
      await fs.mkdir(path.dirname(path.join(scratch, entry)), { recursive: true });
      await fs.cp(path.join(root, entry), path.join(scratch, entry), { recursive: true });
    }
    await fs.symlink(path.join(root, "node_modules"), path.join(scratch, "node_modules"), "dir");
    const run = (...args) => exec(process.execPath, [path.join(scratch, "scripts/api.mjs"), ...args], { cwd: scratch });
    const report = path.join(scratch, "etc/sdk.api.md");
    const originalReport = await fs.readFile(report, "utf8");
    const docs = path.join(scratch, "docs/api/index.md");
    const originalDocs = await fs.readFile(docs, "utf8");
    await fs.writeFile(docs, originalDocs + "\nstale\n");
    await assert.rejects(run(), error => error.stderr.includes("is stale"));
    assert.equal(await fs.readFile(report, "utf8"), originalReport);
    assert.equal(await fs.readFile(docs, "utf8"), originalDocs + "\nstale\n");
    await fs.writeFile(docs, originalDocs);
    const extra = path.join(scratch, "types/obsolete.d.ts");
    await fs.writeFile(extra, "export {};\n");
    await assert.rejects(run(), error => error.stderr.includes("missing or stale files"));
    await fs.rm(extra);
    await fs.rm(docs);
    await assert.rejects(run(), error => error.stderr.includes("missing or stale files"));
    await fs.writeFile(docs, originalDocs);
    await fs.writeFile(report, originalReport + "\nUNREVIEWED\n");
    await assert.rejects(run(), error => error.stderr.includes("Public API extraction failed"));
    assert.equal(await fs.readFile(report, "utf8"), originalReport + "\nUNREVIEWED\n");
    await run("--update");
    assert.equal(await fs.readFile(report, "utf8"), originalReport);
    assert.equal(await fs.readFile(docs, "utf8"), originalDocs);
    await run("--update");
    assert.equal(await fs.readFile(report, "utf8"), originalReport);
    await run();
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
