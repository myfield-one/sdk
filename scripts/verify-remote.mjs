import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const configuredAuth = process.env.MYFIELD_TEST_AUTH_URL;
if (!configuredAuth) throw new Error("Set MYFIELD_TEST_AUTH_URL to a test authorization page");
const authUrl = new URL(configuredAuth);
if (!["http:", "https:"].includes(authUrl.protocol) || authUrl.username || authUrl.password || authUrl.search || authUrl.hash
  || authUrl.hostname === "myfield.one" || authUrl.hostname.endsWith(".myfield.one")) throw new Error("Use a test HTTP(S) authorization URL without credentials, query or fragment");
const port = Number(process.env.MYFIELD_TEST_PORT || 5199);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid MYFIELD_TEST_PORT");
const origin = `http://127.0.0.1:${port}`;
await fs.mkdir(path.join(root, "tmp/remote-verification"), { recursive: true });
const output = await fs.mkdtemp(path.join(root, "tmp/remote-verification/run-"));
const bundle = await build({ entryPoints: [path.join(root, "scripts/verify-remote-browser.js")],
  bundle: true, format: "esm", target: "es2022", write: false, metafile: true, absWorkingDir: root,
  define: { __MYFIELD_TEST_AUTH_URL__: JSON.stringify(authUrl.href) },
});
const code = bundle.outputFiles[0].contents;
const hash = contents => createHash("sha256").update(contents).digest("hex");
const sources = {};
for (const filename of Object.keys(bundle.metafile.inputs)) sources[filename] = hash(await fs.readFile(path.resolve(root, filename)));
sources["scripts/verify-remote.mjs"] = hash(await fs.readFile(fileURLToPath(import.meta.url)));
const manifest = { createdAt: new Date().toISOString(), version: JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version,
  authUrl: authUrl.href, bundleHash: hash(code), sources };
await fs.writeFile(path.join(output, "build.json"), JSON.stringify(manifest, null, 2));
await fs.writeFile(path.join(output, "verify.js"), code);
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Remote API verification</title>
<h1>Remote API verification</h1><p>Use a test Keychain. Verification writes synthetic encrypted objects.</p>
<button id="connectButton">Connect</button><button id="verifyButton" disabled>Verify</button>
<pre id="status">Restoring access…</pre><pre id="result"></pre><script type="module" src="/verify.js"></script></html>`;
const server = http.createServer(async (request, response) => {
  response.setHeader("cache-control", "no-store");
  try {
    const pathname = new URL(request.url, origin).pathname;
    if (request.method === "GET" && pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8"); response.end(page);
    } else if (request.method === "GET" && pathname === "/verify.js") {
      response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(code);
    } else if (request.method === "POST" && pathname === "/report" && request.headers.origin === origin) {
      let body = "";
      for await (const chunk of request) { body += chunk; if (body.length > 1024 * 1024) throw new Error("Report too large"); }
      const report = JSON.parse(body);
      const filename = `report-${Date.now()}.json`;
      await fs.writeFile(path.join(output, filename), JSON.stringify({ ...report, build: manifest }, null, 2));
      console.log(`Report: ${path.join(output, filename)}`);
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ file: filename }));
    } else { response.statusCode = 404; response.end("Not found"); }
  } catch (error) { response.statusCode = 400; response.end(error.message); }
});
server.listen(port, "127.0.0.1", () => console.log(`Remote verification: ${origin}\nAuthorization: ${authUrl.href}\nArtifacts: ${output}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
