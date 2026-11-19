import fs from "node:fs/promises";
import path from "node:path";

export async function checkExactPath(root, target) {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Documentation link leaves the package");
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const entries = await fs.readdir(current);
    if (!entries.includes(segment)) throw new Error(`Missing or incorrectly cased path: ${target}`);
    current = path.join(current, segment);
  }
}
