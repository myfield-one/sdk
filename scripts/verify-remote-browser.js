import { createInstance } from "../src/index.ts";

const check = (value, message) => { if (!value) throw new Error(message); };
const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), message);
const hash = async bytes => "sha256:" + btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))))
  .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

async function verifyRemote(instance, signal) {
  const remote = instance.remote.getBucket();
  const stream = await remote.watchFeed({ signal });
  let payload, objectId, versions;
  try {
    const initial = await remote.getIndex({ signal });
    await remote.listFeed({ cursor: initial.feedCursor, signal });
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key,
      new TextEncoder().encode("Synthetic Remote API verification")));
    payload = new Uint8Array(iv.length + encrypted.length); payload.set(iv); payload.set(encrypted, iv.length);
    const payloadHash = await hash(payload);
    objectId = "verification-" + crypto.randomUUID(); versions = [];
    check(await remote.getCurrent(objectId, { signal }) === null, "Missing current must be null");
    for (let i = 0; i < 3; i++) {
      const versionId = crypto.randomUUID(), parent = versions.at(-1);
      const result = await remote.commit({ meta: { objectId, versionId, parentVersionIds: parent ? [parent] : [], payloadHash },
        payload, expectedHeadVersionId: parent ?? null }, { signal });
      check(result.ok, "Commit failed"); versions.push(versionId);
    }
    for (const versionId of versions) {
      const next = await stream.next();
      check(!next.done, "Stream ended before changes arrived");
      equal(next.value, { objectId, versionId }, "Unexpected hint or public readiness event");
    }
    const current = await remote.getCurrent(objectId, { knownVersionId: versions[0], signal });
    equal(current.history, [...versions].reverse(), "Ancestry path differs");
    equal((await remote.getCurrent(objectId, { knownVersionId: versions.at(-1), signal })).history,
      [versions.at(-1)], "Same-version evidence differs");
    const unknownHistory = (await remote.getCurrent(objectId, { knownVersionId: crypto.randomUUID(), signal })).history;
    check(unknownHistory === null || (Array.isArray(unknownHistory) && unknownHistory.length === 0),
      "Unknown version must have no proof or incomplete evidence");
    const first = await remote.listVersions(objectId, versions.at(-1), { limit: 2, signal });
    equal(first.history, [...versions].reverse().slice(0, 2), "History first page differs");
    check(typeof first.nextCursor === "string", "History continuation missing");
    const last = await remote.listVersions(objectId, versions.at(-1), { cursor: first.nextCursor, limit: 2, signal });
    equal(last.history, [versions[0]], "History second page differs");
    check(last.nextCursor === null, "History should end");
    const version = await remote.getVersion(objectId, versions.at(-1), { signal });
    check(await hash(await version.payload.arrayBuffer()) === payloadHash, "Payload hash differs");
    const refused = await remote.commit({ meta: { objectId, versionId: crypto.randomUUID(), parentVersionIds: [], payloadHash },
      payload, expectedHeadVersionId: null }, { signal });
    check(!refused.ok && refused.reason === "version-mismatch", "Expected CAS rejection");
    const index = await remote.getIndex({ signal });
    const discovered = new Map(index.objects.map(row => [row.objectId, row.versionId]));
    let cursor = index.feedCursor, more = true, feedEntries = 0;
    while (more) {
      const page = await remote.listFeed({ cursor, limit: 2, signal });
      for (const row of page.entries) discovered.set(row.objectId, row.versionId);
      feedEntries += page.entries.length; more = page.hasMore;
      if (more) check(page.cursor !== cursor, "Feed cursor did not advance");
      cursor = page.cursor;
    }
    check(discovered.get(objectId) === versions.at(-1), "Index/feed did not find the current version");
    const disconnected = await verifyDisconnect(instance, signal);
    try { await stream.next(); throw new Error("Expected disconnected stream"); }
    catch (error) { check(error.name === "AbortError", "Disconnected stream must stop hints"); }
    return { objectId, versions, initialCursor: initial.feedCursor, hints: 3, ancestry: current.history, unknownHistory,
      historyPages: [first.history, last.history], feedEntries, casRejected: true,
      disconnectStopsHints: true, cloudHeadVerified: current.versionId === versions.at(-1), ...disconnected };
  } finally { await stream.return(); }
}

async function verifyDisconnect(instance, signal) {
  const remote = instance.remote.getBucket(), cancel = new AbortController();
  const abort = () => cancel.abort(signal.reason);
  signal.throwIfAborted(); signal.addEventListener("abort", abort, { once: true });
  try {
    const stream = await remote.watchFeed({ signal: cancel.signal });
    const reading = stream.next(), reason = new DOMException("Verification cancelled", "AbortError");
    cancel.abort(reason);
    try { await reading; throw new Error("Expected cancellation"); }
    catch (error) { check(error === reason, "Stream cancellation reason differs"); }
  } finally { signal.removeEventListener("abort", abort); }
  await instance.disconnect();
  check(instance.state === "disconnected", "Disconnect failed");
  try { await remote.getIndex({ signal }); throw new Error("Expected NOT_AUTHORIZED"); }
  catch (error) { check(error.code === "NOT_AUTHORIZED", "Disconnected Remote must reject"); }
  return { streamCancelled: true };
}

const instance = createInstance("sdk-remote-verification.example");
const status = document.getElementById("status"), result = document.getElementById("result");
const connect = document.getElementById("connectButton"), verify = document.getElementById("verifyButton");
instance.on("state", (state, error) => { status.textContent = state + (error ? ": " + error.code : ""); verify.disabled = state !== "connected"; });
const restoring = instance.resume();
restoring.then(state => { status.textContent = state; verify.disabled = state !== "connected"; })
  .catch(error => { status.textContent = error.code || error.message; });
connect.onclick = async () => { try { await instance.connect(); } catch (error) { status.textContent = error.code || error.message; } };
async function run() {
  verify.disabled = connect.disabled = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Verification timed out", "TimeoutError")), 60000);
  let report;
  try { report = { ok: true, generatedAt: new Date().toISOString(), result: await verifyRemote(instance, controller.signal) }; }
  catch (error) { report = { ok: false, generatedAt: new Date().toISOString(), error: { code: error.code, message: error.message, status: error.status } }; }
  finally { clearTimeout(timer); controller.abort(); connect.disabled = false; verify.disabled = instance.state !== "connected"; }
  result.textContent = JSON.stringify(report, null, 2);
  const saved = await fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) });
  check(saved.ok, "Could not save report");
  return report;
}
verify.onclick = () => run().catch(error => { status.textContent = error.message; });
window.remoteVerification = { instance, restoring, run };
