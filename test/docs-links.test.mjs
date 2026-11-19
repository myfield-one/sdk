import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkExactPath } from "../scripts/lib/docs-path.mjs";

test("documentation links require exact file and directory casing without a Git checkout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-docs-case-"));
  try {
    await fs.mkdir(path.join(root, "docs/api"), { recursive: true });
    await fs.writeFile(path.join(root, "docs/api.md"), "# API\n");
    await fs.writeFile(path.join(root, "docs/api/Instance.md"), "# Instance\n");
    await checkExactPath(root, path.join(root, "docs/api.md"));
    await checkExactPath(root, path.join(root, "docs/api/Instance.md"));
    for (const relative of ["docs/API.md", "Docs/api.md", "docs/API/Instance.md", "docs/api/instance.md", "docs/missing.md"]) {
      await assert.rejects(checkExactPath(root, path.join(root, relative)), /Missing or incorrectly cased path/);
    }
    await assert.rejects(checkExactPath(root, path.resolve(root, "../outside.md")), /leaves the package/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
