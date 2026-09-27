import fs from "node:fs";
import { defineAction, decodeText } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { WorkspaceError, WorkspaceErrorCode } from "../src/errors.ts";
import { WorkspacePathPolicy } from "../src/path-policy.ts";

export type Input = ActionInput<"bash.exec">;
export type Output = ActionOutput<"bash.exec">;

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB

function resolveBashExecutable(): string {
  if (fs.existsSync("/bin/bash")) {
    return "/bin/bash";
  }
  if (fs.existsSync("/usr/bin/bash")) {
    return "/usr/bin/bash";
  }
  return "bash";
}

export default defineAction<Input, Output>(async (input, ctx) => {
  const command = input.command?.trim();
  if (!command) {
    throw new WorkspaceError(
      "Command must not be empty",
      WorkspaceErrorCode.INVALID_ARGUMENT,
      400
    );
  }

  const workspaceRoot = ctx.config.get<string>("WORKSPACE_ROOT", process.cwd());
  const pathPolicy = new WorkspacePathPolicy(workspaceRoot);

  const resolvedCwd = pathPolicy.resolveAndValidate(input.cwd ?? "");
  if (!resolvedCwd.stat?.isDirectory()) {
    throw new WorkspaceError(
      `Working directory is not a directory: ${input.cwd}`,
      WorkspaceErrorCode.NOT_A_DIRECTORY,
      400
    );
  }
  const cwd = resolvedCwd.absolutePath;

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await ctx.process.run(
    {
      spec: {
        executable: resolveBashExecutable(),
        args: ["-c", command],
        cwd,
        env: {
          inherit: "allowlisted",
          set: {
            PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
            GIT_TERMINAL_PROMPT: "0",
            GIT_MERGE_AUTOEDIT: "no",
            // 容器启动时由 entrypoint 注入，控制 SSH 指纹库落盘位置（不在默认白名单内，需显式透传）
            ...(process.env.GIT_SSH_COMMAND
              ? { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND }
              : {}),
          },
        },
        io: { mode: "pipe" },
      },
      timeoutMs,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    },
    { signal: ctx.signal }
  );

  const content = decodeText(res.chunks);

  return {
    exitCode: res.exit.code,
    content,
    truncated: res.truncated,
  };
});
