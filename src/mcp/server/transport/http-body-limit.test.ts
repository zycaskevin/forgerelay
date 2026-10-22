import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../../../runtime/config/config.js";
import { createServer } from "../../../server.js";

function bodyOfBytes(bytes: number): string {
  const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "edit", arguments: { text: "private-body-marker" } } };
  const text = JSON.stringify(body);
  body.params.arguments.text += "x".repeat(bytes - Buffer.byteLength(text));
  return JSON.stringify(body);
}

async function withServer(
  limit: number | undefined,
  run: (endpoint: string, logs: string[]) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(process.cwd(), ".forgerelay-debug/body-limit-"));
  const logs: string[] = [];
  const config = loadConfig({
    FORGERELAY_CONFIG_DIR: join(root, "config"),
    FORGERELAY_STATE_DIR: join(root, "state"),
    FORGERELAY_ALLOWED_ROOTS: root,
    FORGERELAY_WORKTREE_ROOT: join(root, "worktrees"),
    FORGERELAY_OAUTH_OWNER_TOKEN: "body-limit-owner-token-long-enough",
    FORGERELAY_LOG_FORMAT: "json",
    FORGERELAY_LOG_LEVEL: "info",
    FORGERELAY_LOG_REQUESTS: "1",
    ...(limit === undefined ? {} : { FORGERELAY_HTTP_MAX_REQUEST_BYTES: String(limit) }),
    HOST: "127.0.0.1",
    PORT: "7678",
  });
  const running = createServer(config);
  const server = running.app.listen(7678, "127.0.0.1");
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    await once(server, "listening");
    await run("http://127.0.0.1:7678", logs);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await running.close();
    console.log = originalLog;
    console.warn = originalWarn;
    await rm(root, { recursive: true, force: true });
  }
}

// Keep runtime state in the repository's dedicated, ignored debug directory.
await mkdir(join(process.cwd(), ".forgerelay-debug"), { recursive: true });

test("JSON above the old 100 KiB limit reaches OAuth and ordinary request tracing", async () => {
  await withServer(undefined, async (endpoint, logs) => {
    const body = bodyOfBytes(103_080);
    assert.equal(Buffer.byteLength(body), 103_080);
    const response = await fetch(`${endpoint}/mcp?token=query-secret`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    assert.equal(response.status, 401);
    assert.match(await response.text(), /Missing Authorization header/);
    const requestId = response.headers.get("x-forgerelay-request-id");
    assert.match(requestId ?? "", /^[0-9a-f-]{36}$/);
    const event = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === "http_request");
    assert.equal(event.requestId, requestId);
    assert.equal(event.status, 401);
    assert.equal(event.path, "/mcp");
    assert.equal(event.contentLength, "103080");
    assert.doesNotMatch(logs.join("\n"), /private-body-marker|query-secret|"arguments"/);

    const forbidden = await fetch(`${endpoint}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body,
    });
    assert.equal(forbidden.status, 403);
    await forbidden.text();
    assert.ok(forbidden.headers.get("x-forgerelay-request-id"));
    const asset = await fetch(`${endpoint}/mcp-app-assets/assets/activity-panel-app.js`, {
      method: "OPTIONS", headers: { origin: "https://example.web-sandbox.oaiusercontent.com" },
    });
    assert.equal(asset.status, 204);
    assert.equal(asset.headers.get("access-control-allow-origin"), "*");
  });
});

test("configured JSON limit returns bounded JSON-RPC 413 and correlated safe logs", async () => {
  const limit = 128 * 1024;
  await withServer(limit, async (endpoint, logs) => {
    const response = await fetch(`${endpoint}/mcp?token=query-secret`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer auth-secret",
        referer: "https://example.test/?token=referer-secret",
        "user-agent": "private-agent-marker".repeat(100),
      },
      body: bodyOfBytes(limit + 1),
    });
    assert.equal(response.status, 413);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const text = await response.text();
    assert.ok(text.length < 256);
    assert.deepEqual(JSON.parse(text), {
      jsonrpc: "2.0", id: null,
      error: { code: -32000, message: "JSON request body exceeds the configured byte limit" },
    });
    const requestId = response.headers.get("x-forgerelay-request-id");
    assert.match(requestId ?? "", /^[0-9a-f-]{36}$/);
    const events = logs.map((line) => JSON.parse(line));
    const rejection = events.find((entry) => entry.event === "http_request_body_too_large");
    assert.equal(rejection.requestId, requestId);
    assert.equal(rejection.method, "POST");
    assert.equal(rejection.path, "/mcp");
    assert.equal(rejection.contentLength, String(limit + 1));
    assert.equal(rejection.limitBytes, limit);
    assert.equal(events.find((entry) => entry.event === "http_request")?.status, 413);
    assert.ok(logs.every((line) => line.length < 1024));
    assert.doesNotMatch(logs.join("\n"), /private-body-marker|query-secret|auth-secret|referer-secret|private-agent-marker|"arguments"/);

    const atLimit = await fetch(`${endpoint}/mcp`, {
      method: "POST", headers: { "content-type": "application/json" }, body: bodyOfBytes(limit),
    });
    assert.equal(atLimit.status, 401);
    await atLimit.text();
  });
});
