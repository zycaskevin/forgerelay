import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import {
  allResponseText,
  callOpen,
  fixture,
  structuredContent,
} from "../../runtime/testing/server-fixture.js";

test("inspect provides bounded read-only workspace diagnostics", async (t) => {
  const context = await fixture(t, { git: true });
  const conversation = "chat-inspect";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (arguments_: Record<string, unknown>) => context.client.callTool({
    name: "inspect",
    arguments: { workspaceId, ...arguments_ },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);

  await writeFile(join(context.project, "dirty.txt"), "dirty\n");
  const status = await call({ operation: "git.status" });
  assert.equal(status.isError, undefined);
  assert.match(allResponseText(status), /dirty\.txt/);

  await writeFile(join(context.project, "README.md"), "changed\n");
  const diff = await call({ operation: "git.diff", paths: ["README.md"] });
  assert.equal(diff.isError, undefined);
  assert.match(allResponseText(diff), /changed/);

  const log = await call({ operation: "git.log", limit: 1 });
  assert.equal(log.isError, undefined);
  assert.match(allResponseText(log), /Initial commit/);

  const stat = await call({ operation: "filesystem.stat", path: "README.md" });
  assert.equal(stat.isError, undefined);
  assert.match(allResponseText(stat), /"path": "README\.md"/);
  assert.match(allResponseText(stat), /"type": "file"/);

  const outside = await mkdtemp(join(tmpdir(), "forgerelay-inspect-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideFile = join(outside, "outside.txt");
  await writeFile(outsideFile, "outside\n");
  await symlink(outsideFile, join(context.project, "escape.txt"));
  const escaped = await call({ operation: "filesystem.stat", path: "escape.txt" });
  assert.equal(escaped.isError, true);
  assert.match(allResponseText(escaped), /escapes the workspace root/i);

  const invalidService = await call({ operation: "service.status", unit: "--system.service" });
  assert.equal(invalidService.isError, true);
  assert.match(allResponseText(invalidService), /exact user service name/i);
});

test("inspect schema has no arbitrary command surface", async (t) => {
  const context = await fixture(t);
  const tools = await context.client.listTools();
  const inspect = tools.tools.find((tool) => tool.name === "inspect");
  assert.ok(inspect);
  assert.deepEqual(inspect.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  const properties = (inspect.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  assert.equal("command" in properties, false);
  assert.equal("argv" in properties, false);
  assert.equal("executable" in properties, false);
});
