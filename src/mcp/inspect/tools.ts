import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { mcpHandlerRequestContext } from "../request-context.js";
import type { WorkspaceRegistry } from "../../workspaces.js";
import type { ProcessExecutionTarget } from "../process/tools.js";

const execFileAsync = promisify(execFile);

const INSPECT_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const SERVICE_NAME = /^(?!-)[A-Za-z0-9_.@:-]+\.service$/;
const MAX_OUTPUT_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;

const inspectOperationSchema = z.enum([
  "git.status",
  "git.diff",
  "git.log",
  "process.list",
  "listener.list",
  "service.status",
  "journal.tail",
  "filesystem.stat",
]);

type InspectOperation = z.infer<typeof inspectOperationSchema>;

export interface RegisterInspectToolsOptions {
  server: McpServer;
  workspaces: WorkspaceRegistry;
  resolveExecutionTarget: (workspaceId: string, member?: string) => ProcessExecutionTarget;
  prepareExecutionContext: (
    target: ProcessExecutionTarget,
    requestContext: ReturnType<typeof mcpHandlerRequestContext>,
  ) => Promise<unknown>;
  isRemote: (workspaceId: string) => boolean;
  presentSemanticWorkResult: <T>(
    result: T,
    target: ProcessExecutionTarget,
    conversationScopeId?: string,
  ) => T;
  hostScopeIdFor: (requestContext: ReturnType<typeof mcpHandlerRequestContext>) => string;
}

function textResult(
  operation: InspectOperation,
  result: string,
  truncated = false,
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { operation: InspectOperation; result: string; truncated: boolean };
} {
  return {
    content: [{ type: "text", text: result }],
    structuredContent: { operation, result, truncated },
  };
}

function boundedLines(raw: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const hasTrailingEmpty = lines.at(-1) === "";
  if (hasTrailingEmpty) lines.pop();
  if (lines.length <= maxLines) {
    return { text: lines.join("\n"), truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join("\n") + `\n… truncated to ${maxLines} lines`,
    truncated: true,
  };
}

async function runReadOnlyCommand(
  file: string,
  args: string[],
  cwd: string,
  maxLines: number,
): Promise<{ text: string; truncated: boolean }> {
  const { stdout, stderr } = await execFileAsync(file, args, {
    cwd,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: "utf8",
    windowsHide: true,
  });
  const output = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");
  return boundedLines(output, maxLines);
}

function requireServiceName(unit: string | undefined): string {
  if (!unit || !SERVICE_NAME.test(unit)) {
    throw new Error("inspect service operations require an exact user service name ending in .service.");
  }
  return unit;
}

function requireLinux(operation: InspectOperation): void {
  if (process.platform !== "linux") {
    throw new Error(`inspect ${operation} is currently supported on Linux only.`);
  }
}

function requireGitPaths(paths: string[] | undefined): string[] {
  if (!paths) return [];
  for (const path of paths) {
    if (
      path.length === 0 ||
      isAbsolute(path) ||
      path.split(/[\\/]+/).includes("..") ||
      path.startsWith(":")
    ) {
      throw new Error("inspect git paths must be relative workspace paths without '..' or Git pathspec magic.");
    }
  }
  return paths;
}

async function containedExistingPath(workspaceRoot: string, requestedPath: string): Promise<string> {
  const root = await realpath(workspaceRoot);
  const candidate = resolve(root, requestedPath);
  const canonical = await realpath(candidate);
  const rel = relative(root, canonical);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("inspect filesystem.stat path escapes the workspace root.");
  }
  return canonical;
}

export function registerInspectTools(options: RegisterInspectToolsOptions): void {
  const {
    server,
    workspaces,
    resolveExecutionTarget,
    prepareExecutionContext,
    isRemote,
    presentSemanticWorkResult,
    hostScopeIdFor,
  } = options;

  registerAppTool(
    server,
    "inspect",
    {
      title: "Inspect workspace",
      description:
        "Read-only local diagnostics for an open ForgeRelay Workspace without invoking a shell. " +
        "Use this for Git status/diff/log, process and TCP listener listings, user-service status, " +
        "bounded user-journal reads, and workspace filesystem metadata. It cannot mutate Git, files, " +
        "processes, services, or network state.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        member: z.string().optional().describe("Required for a Composite Workspace; member that owns the local inspection."),
        operation: inspectOperationSchema,
        staged: z.boolean().optional().describe("git.diff only: inspect staged changes."),
        paths: z.array(z.string()).max(100).optional().describe("git.diff only: relative workspace paths."),
        limit: z.number().int().min(1).max(500).optional().describe("Bounded result size. git.log max 100; other line-based operations max 500."),
        unit: z.string().optional().describe("service.status or journal.tail only: exact user service name ending in .service."),
        since: z.string().max(128).optional().describe("journal.tail only: optional journalctl --since value."),
        path: z.string().max(4096).optional().describe("filesystem.stat only: path inside the workspace root."),
      },
      outputSchema: {
        operation: inspectOperationSchema,
        result: z.string(),
        truncated: z.boolean(),
      },
      _meta: {},
      annotations: INSPECT_ANNOTATIONS,
    },
    async ({ workspaceId, member, operation, staged, paths, limit, unit, since, path }, extra) => {
      const requestContext = mcpHandlerRequestContext(extra);
      const target = resolveExecutionTarget(workspaceId, member);
      if (isRemote(target.executionWorkspaceId)) {
        throw new Error("inspect currently supports local Workspaces only; use the remote ForgeRelay directly for read-only inspection.");
      }
      await prepareExecutionContext(target, requestContext);

      const workspace = workspaces.getWorkspace(target.executionWorkspaceId);
      const root = workspace.root;
      let inspected: { text: string; truncated: boolean };

      switch (operation) {
        case "git.status":
          inspected = await runReadOnlyCommand(
            "git",
            ["--no-pager", "-c", "core.fsmonitor=false", "status", "--short", "--branch", "--untracked-files=normal"],
            root,
            Math.min(limit ?? 300, 500),
          );
          break;

        case "git.diff": {
          const safePaths = requireGitPaths(paths);
          const args = ["--no-pager", "-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color"];
          if (staged) args.push("--cached");
          if (safePaths.length > 0) args.push("--", ...safePaths);
          inspected = await runReadOnlyCommand("git", args, root, Math.min(limit ?? 500, 500));
          break;
        }

        case "git.log":
          inspected = await runReadOnlyCommand(
            "git",
            [
              "--no-pager",
              "-c",
              "core.fsmonitor=false",
              "log",
              `-n${Math.min(limit ?? 20, 100)}`,
              "--no-show-signature",
              "--no-color",
              "--format=%h %ad %s",
              "--date=iso-strict",
            ],
            root,
            Math.min(limit ?? 20, 100),
          );
          break;

        case "process.list":
          requireLinux(operation);
          inspected = await runReadOnlyCommand(
            "ps",
            ["-eo", "pid,ppid,etimes,stat,comm", "--sort=pid"],
            root,
            Math.min(limit ?? 300, 500),
          );
          break;

        case "listener.list":
          requireLinux(operation);
          inspected = await runReadOnlyCommand(
            "ss",
            ["-ltnpH"],
            root,
            Math.min(limit ?? 300, 500),
          );
          break;

        case "service.status": {
          requireLinux(operation);
          const service = requireServiceName(unit);
          inspected = await runReadOnlyCommand(
            "systemctl",
            [
              "--user",
              "show",
              "--no-pager",
              "--property=Id,LoadState,ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestamp,MemoryCurrent,TasksCurrent",
              "--",
              service,
            ],
            root,
            Math.min(limit ?? 100, 500),
          );
          break;
        }

        case "journal.tail": {
          requireLinux(operation);
          const service = requireServiceName(unit);
          const args = ["--user", "-u", service, "--no-pager", "-n", String(Math.min(limit ?? 100, 500))];
          if (since) args.push("--since", since);
          inspected = await runReadOnlyCommand(
            "journalctl",
            args,
            root,
            Math.min(limit ?? 100, 500),
          );
          break;
        }

        case "filesystem.stat": {
          if (!path) throw new Error("inspect filesystem.stat requires path.");
          const canonical = await containedExistingPath(root, path);
          const info = await stat(canonical);
          inspected = {
            text: JSON.stringify({
              path: relative(await realpath(root), canonical) || ".",
              type: info.isFile() ? "file" : info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "other",
              size: info.size,
              mode: info.mode & 0o7777,
              modifiedAt: info.mtime.toISOString(),
            }, null, 2),
            truncated: false,
          };
          break;
        }
      }

      return presentSemanticWorkResult(
        textResult(operation, inspected.text, inspected.truncated),
        target,
        hostScopeIdFor(requestContext),
      );
    },
  );
}
