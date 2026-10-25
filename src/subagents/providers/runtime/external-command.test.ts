import assert from "node:assert/strict";
import { runExternalCommand } from "./external-command.js";

const echoed = await runExternalCommand({
  command: process.execPath,
  args: [
    "-e",
    "let s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => s += c); process.stdin.on('end', () => process.stdout.write('EOF:' + s));",
  ],
  stdin: "prompt-through-stdin",
  label: "stdin-fixture",
  timeoutMs: 2_000,
});
assert.equal(echoed.stdout, "EOF:prompt-through-stdin");
assert.equal(echoed.exitCode, 0);

const empty = await runExternalCommand({
  command: process.execPath,
  args: [
    "-e",
    "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('EMPTY-EOF'));",
  ],
  label: "empty-stdin-fixture",
  timeoutMs: 2_000,
});
assert.equal(empty.stdout, "EMPTY-EOF");
assert.equal(empty.exitCode, 0);

await assert.rejects(
  runExternalCommand({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    label: "timeout-fixture",
    timeoutMs: 100,
  }),
  /timed out after 100ms/,
);
