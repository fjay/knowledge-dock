import fs from "node:fs";
import path from "node:path";
import type { ActionContext } from "@actiondock/sdk";
import { decodeText } from "@actiondock/sdk";
import { MaintenanceError } from "./errors.ts";
import { DEFAULT_GIT_TIMEOUT_MS, DEFAULT_GIT_CLONE_TIMEOUT_MS, DEFAULT_GIT_MAX_OUTPUT_BYTES } from "./limits.ts";

export interface GitRunnerOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

export interface GitCloneOptions {
  filterBlobNone?: boolean | undefined;
  branch?: string | undefined;
  timeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
}

export interface GitExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Shared low-level git execution: env injection, output decoding and signal checks.
 */
async function execGit(
  ctx: ActionContext,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    env?: Record<string, string>;
  }
): Promise<GitExecResult> {
  if (ctx.signal.aborted) {
    throw new MaintenanceError("Git operation aborted by caller", "OPERATION_ABORTED", 499);
  }

  ctx.log.debug(`Executing: git ${args.join(" ")} in ${options.cwd}`);

  const res = await ctx.process.run(
    {
      spec: {
        executable: "git",
        args,
        cwd: options.cwd,
        env: {
          inherit: "allowlisted",
          set: {
            GIT_TERMINAL_PROMPT: "0",
            GIT_MERGE_AUTOEDIT: "no",
            // 容器启动时由 entrypoint 注入，控制 SSH 指纹库落盘位置（不在默认白名单内，需显式透传）
            ...(process.env.GIT_SSH_COMMAND
              ? { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND }
              : {}),
            ...(options.env ?? {}),
          },
        },
        io: { mode: "pipe" },
      },
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    },
    { signal: ctx.signal }
  );

  const stdoutChunks = res.chunks.filter((c) => c.stream === "stdout");
  const stderrChunks = res.chunks.filter((c) => c.stream === "stderr");
  return {
    code: res.exit.code,
    signal: res.exit.signal,
    stdout: decodeText(stdoutChunks),
    stderr: decodeText(stderrChunks),
  };
}

/**
 * Detects whether a failed fetch/clone stems from unsupported partial clone filtering.
 */
function isFilterUnsupported(res: GitExecResult): boolean {
  const combined = (res.stderr + " " + res.stdout).toLowerCase();
  return (
    combined.includes("filter") ||
    combined.includes("unknown option") ||
    combined.includes("not supported") ||
    combined.includes("unsupported")
  );
}

export class GitClient {
  private readonly ctx: ActionContext;
  private readonly defaultCwd: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxOutputBytes: number;

  constructor(
    ctx: ActionContext,
    defaultCwd: string,
    defaultTimeoutMs: number = DEFAULT_GIT_TIMEOUT_MS,
    defaultMaxOutputBytes: number = DEFAULT_GIT_MAX_OUTPUT_BYTES
  ) {
    this.ctx = ctx;
    this.defaultCwd = defaultCwd;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.defaultMaxOutputBytes = defaultMaxOutputBytes;
  }

  async run(args: string[], options?: GitRunnerOptions): Promise<GitExecResult> {
    return execGit(this.ctx, args, {
      cwd: options?.cwd ?? this.defaultCwd,
      timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs,
      maxOutputBytes: options?.maxOutputBytes ?? this.defaultMaxOutputBytes,
      ...(options?.env ? { env: options.env } : {}),
    });
  }

  async isInsideWorkTree(): Promise<boolean> {
    const res = await this.run(["rev-parse", "--is-inside-work-tree"]);
    return res.code === 0 && res.stdout.trim() === "true";
  }

  async getPorcelainStatus(): Promise<string[]> {
    const res = await this.run(["status", "--porcelain"]);
    if (res.code !== 0) {
      throw new MaintenanceError(
        `git status failed: ${res.stderr.trim() || res.stdout.trim()}`,
        "GIT_ERROR",
        500
      );
    }
    return res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async getHeadCommit(branch?: string): Promise<string> {
    const target = branch ? `${branch}^{commit}` : "HEAD";
    const res = await this.run(["rev-parse", target]);
    if (res.code !== 0) {
      throw new MaintenanceError(
        `Failed to resolve commit for '${branch || "HEAD"}': ${res.stderr.trim()}`,
        "COMMIT_NOT_FOUND",
        404
      );
    }
    return res.stdout.trim();
  }

  async verifyCommitExists(commit: string): Promise<string> {
    const check = await this.run(["cat-file", "-e", `${commit}^{commit}`]);
    if (check.code !== 0) {
      throw new MaintenanceError(
        `Commit '${commit}' does not exist in repository`,
        "COMMIT_NOT_FOUND",
        404
      );
    }
    const parse = await this.run(["rev-parse", `${commit}^{commit}`]);
    if (parse.code !== 0) {
      throw new MaintenanceError(
        `Failed to resolve full hash for commit '${commit}'`,
        "COMMIT_NOT_FOUND",
        404
      );
    }
    return parse.stdout.trim();
  }

  async getRemoteUrl(): Promise<string | null> {
    const res = await this.run(["config", "--get", "remote.origin.url"]);
    if (res.code === 0 && res.stdout.trim().length > 0) {
      return res.stdout.trim();
    }
    return null;
  }

  async listBranchNames(): Promise<string[]> {
    const res = await this.run(["branch", "-a", "--format=%(refname:short)"]);
    if (res.code !== 0) {
      throw new MaintenanceError(
        `git branch failed: ${res.stderr.trim() || res.stdout.trim()}`,
        "GIT_ERROR",
        500
      );
    }
    return res.stdout
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);
  }

  async refExists(ref: string): Promise<boolean> {
    const res = await this.run(["rev-parse", "--verify", ref]);
    return res.code === 0;
  }

  /**
   * Resolves repository default branch dynamically from remote origin/HEAD or local branches.
   */
  async getDefaultBranch(): Promise<string> {
    const headRes = await this.run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (headRes.code === 0 && headRes.stdout.trim()) {
      const branch = headRes.stdout.trim().replace(/^origin\//, "").trim();
      if (branch) return branch;
    }

    const currentRes = await this.run(["branch", "--show-current"]);
    if (currentRes.code === 0 && currentRes.stdout.trim()) {
      return currentRes.stdout.trim();
    }

    if ((await this.refExists("refs/heads/main")) || (await this.refExists("origin/main"))) {
      return "main";
    }
    if ((await this.refExists("refs/heads/master")) || (await this.refExists("origin/master"))) {
      return "master";
    }

    return "main";
  }

  async fetchOrigin(options?: { filterBlobNone?: boolean }): Promise<GitExecResult> {
    const useBlobless = options?.filterBlobNone ?? true;
    if (useBlobless) {
      const bloblessRes = await this.run(["fetch", "--filter=blob:none", "origin"]);
      if (bloblessRes.code === 0) {
        return bloblessRes;
      }

      if (isFilterUnsupported(bloblessRes)) {
        this.ctx.log.warn("Remote origin does not support --filter=blob:none; falling back to standard fetch", {
          error: bloblessRes.stderr.trim(),
        });
        return this.run(["fetch", "origin"]);
      }
      return bloblessRes;
    }

    return this.run(["fetch", "origin"]);
  }

  static async clone(
    ctx: ActionContext,
    url: string,
    targetPath: string,
    options?: GitCloneOptions
  ): Promise<GitExecResult> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_CLONE_TIMEOUT_MS;
    const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES;

    const runClone = async (args: string[]): Promise<GitExecResult> => {
      const parentDir = path.dirname(targetPath);
      try {
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
      } catch {
        // Ignore parent directory creation error and let git handle it
      }

      return execGit(ctx, args, {
        cwd: fs.existsSync(parentDir) ? parentDir : process.cwd(),
        timeoutMs,
        maxOutputBytes,
      });
    };

    const useBlobless = options?.filterBlobNone ?? true;
    if (useBlobless) {
      const bloblessArgs = ["clone", "--filter=blob:none"];
      if (options?.branch) {
        bloblessArgs.push("-b", options.branch);
      }
      bloblessArgs.push(url, targetPath);

      const bloblessRes = await runClone(bloblessArgs);
      if (bloblessRes.code === 0) {
        return bloblessRes;
      }

      if (isFilterUnsupported(bloblessRes)) {
        ctx.log.warn("Remote origin does not support --filter=blob:none; falling back to standard clone", {
          error: bloblessRes.stderr.trim(),
        });
        if (fs.existsSync(targetPath)) {
          try {
            fs.rmSync(targetPath, { recursive: true, force: true });
          } catch {
            // Ignore error
          }
        }
        const fallbackArgs = ["clone"];
        if (options?.branch) {
          fallbackArgs.push("-b", options.branch);
        }
        fallbackArgs.push(url, targetPath);
        return runClone(fallbackArgs);
      }
      return bloblessRes;
    }

    const standardArgs = ["clone"];
    if (options?.branch) {
      standardArgs.push("-b", options.branch);
    }
    standardArgs.push(url, targetPath);
    return runClone(standardArgs);
  }
}
