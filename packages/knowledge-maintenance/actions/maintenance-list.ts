import fs from "node:fs";
import { defineAction, encodeStateKey, type ActionContext } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { GitClient } from "../src/git.ts";
import {
  resolveRepoPath,
  getRepoIdentifier,
  parseGitLog,
  parseDiffStat,
  ensureReposConfigFile,
  detectRepoType,
} from "../src/repo-utils.ts";
import { MaintenanceError } from "../src/errors.ts";

export type Input = ActionInput<"maintenance.list">;
export type Output = ActionOutput<"maintenance.list">;

interface RepoScanConfig {
  path: string;
  repoType?: "code" | "system_knowledge" | undefined;
  branch?: string | undefined;
  sourceBranch?: string | undefined;
}

type SingleRepoScanResult = {
  status: "changed" | "initial" | "upToDate" | "error";
  path: string;
  repo?: string;
  branch?: string;
  repoType?: "code" | "system_knowledge";
  checkpointUpdatedAt?: string | null;
  actionTaken?: string | null;
  hasChanges: boolean;
  from?: string | null;
  to?: string;
  commitCount?: number;
  initialInventoryRequired?: boolean;
  commits?: Array<{
    hash: string;
    shortHash: string;
    message: string;
    author?: string;
    date?: string;
  }>;
  changedFilesSummary?: {
    summaryText?: string;
    filesChanged?: number;
    insertions?: number;
    deletions?: number;
    files?: Array<{
      file: string;
      changes: string;
    }>;
  };
  message: string;
};

/**
 * Scans a single repository for pending commits since checkpoint.
 */
async function scanSingleRepo(
  repoInput: RepoScanConfig,
  ctx: ActionContext,
  throwOnError = false
): Promise<SingleRepoScanResult> {
  ctx.log.info("Inspecting repository maintenance status", {
    path: repoInput.path,
    branch: repoInput.branch,
  });

  try {
    const resolvedPath = resolveRepoPath(repoInput.path);
    const timeoutMs = ctx.config.get<number>("GIT_TIMEOUT_MS", 30000);
    const maxOutputBytes = ctx.config.get<number>("GIT_MAX_OUTPUT_BYTES", 4 * 1024 * 1024);
    const git = new GitClient(ctx, resolvedPath, timeoutMs, maxOutputBytes);

    const isWorkTree = await git.isInsideWorkTree();
    if (!isWorkTree) {
      throw new MaintenanceError(
        `Path is not a valid git repository: ${resolvedPath}`,
        "INVALID_REPO",
        400
      );
    }

    // 1. Determine target branch and repo architecture type
    let repoType = repoInput.repoType;
    if (!repoType) {
      repoType = await detectRepoType(git);
    }

    let targetBranch = repoInput.branch ?? repoInput.sourceBranch;
    if (!targetBranch) {
      targetBranch = repoType === "code" ? "release" : "master";
    }
    const branches = await git.listBranchNames();

    // 优先检查已同步的远程跟踪分支 origin/<targetBranch>
    let commitBranch = targetBranch;
    if (!commitBranch.startsWith("origin/") && branches.includes(`origin/${commitBranch}`)) {
      commitBranch = `origin/${commitBranch}`;
    }

    // 2. Resolve target branch HEAD commit
    const toCommit = await git.getHeadCommit(commitBranch);
    const repoName = await getRepoIdentifier(git, resolvedPath);

    // 3. Read checkpoint from ctx.state
    const stateKey = encodeStateKey("checkpoints", repoName);
    const savedState = await ctx.state.get<any>(stateKey);
    const fromCommit: string | null =
      savedState && typeof savedState.commit === "string" ? savedState.commit : null;
    const checkpointUpdatedAt: string | null =
      savedState && typeof savedState.updatedAt === "string" ? savedState.updatedAt : null;
    const actionTaken: string | null =
      savedState && typeof savedState.actionTaken === "string" ? savedState.actionTaken : null;

    ctx.log.info("Resolved repository checkpoint and target commit", {
      repo: repoName,
      branch: targetBranch,
      repoType,
      from: fromCommit,
      to: toCommit,
    });

    // Strategy B: No prior checkpoint found -> full initial inventory required
    if (!fromCommit) {
      ctx.log.info(`No prior checkpoint found for repository ${repoName}; initial inventory needed`);
      const countRes = await git.run(["rev-list", "--count", toCommit]);
      if (countRes.code !== 0) {
        throw new MaintenanceError(
          `Failed to count commits for ${toCommit}: ${countRes.stderr.trim()}`,
          "GIT_ERROR",
          500
        );
      }
      const totalCommits = parseInt(countRes.stdout.trim() || "0", 10);

      return {
        status: "initial",
        hasChanges: true,
        path: resolvedPath,
        repo: repoName,
        branch: targetBranch,
        repoType,
        checkpointUpdatedAt,
        actionTaken,
        from: null,
        to: toCommit,
        commitCount: totalCommits,
        initialInventoryRequired: true,
        commits: [],
        message: `Initial maintenance check: no checkpoint found in state, full inventory required (${totalCommits} total commits in branch)`,
      };
    }

    // Checkpoint matches current HEAD -> no pending changes
    if (fromCommit === toCommit) {
      ctx.log.info(`Repository ${repoName} is already up to date at checkpoint ${fromCommit}`);
      return {
        status: "upToDate",
        hasChanges: false,
        path: resolvedPath,
        repo: repoName,
        branch: targetBranch,
        repoType,
        checkpointUpdatedAt,
        actionTaken,
        from: fromCommit,
        to: toCommit,
        commitCount: 0,
        initialInventoryRequired: false,
        commits: [],
        changedFilesSummary: {
          summaryText: "0 files changed",
          filesChanged: 0,
          insertions: 0,
          deletions: 0,
          files: [],
        },
        message: "Repository is up to date with last checked commit",
      };
    }

    // Checkpoint differs from HEAD -> compute diff and commits
    ctx.log.info(`Fetching commits and file diff between ${fromCommit} and ${toCommit}...`);

    const logRes = await git.run([
      "log",
      "--pretty=format:%H%x09%h%x09%an <%ae>%x09%aI%x09%s",
      `${fromCommit}..${toCommit}`,
    ]);
    if (logRes.code !== 0) {
      throw new MaintenanceError(
        `Failed to read commit log between ${fromCommit} and ${toCommit}: ${logRes.stderr.trim()}`,
        "GIT_ERROR",
        500
      );
    }
    const commits = parseGitLog(logRes.stdout);

    const diffRes = await git.run(["diff", "--stat", `${fromCommit}..${toCommit}`]);
    if (diffRes.code !== 0) {
      throw new MaintenanceError(
        `Failed to read diff stat between ${fromCommit} and ${toCommit}: ${diffRes.stderr.trim()}`,
        "GIT_ERROR",
        500
      );
    }
    const changedFilesSummary = parseDiffStat(diffRes.stdout);

    const commitCount = commits.length;

    ctx.log.info(`Found ${commitCount} new commit(s) in ${repoName}`);

    return {
      status: "changed",
      hasChanges: true,
      path: resolvedPath,
      repo: repoName,
      branch: targetBranch,
      repoType,
      checkpointUpdatedAt,
      actionTaken,
      from: fromCommit,
      to: toCommit,
      commitCount,
      initialInventoryRequired: false,
      commits,
      changedFilesSummary,
      message: `Found ${commitCount} new commit(s) since last checkpoint`,
    };
  } catch (err: any) {
    if (throwOnError) {
      throw err;
    }
    const errorMsg = err.message || String(err);
    ctx.log.error("Failed scanning repository", { path: repoInput.path, error: errorMsg });
    return {
      status: "error",
      path: repoInput.path,
      hasChanges: false,
      message: errorMsg,
    };
  }
}

export default defineAction<Input, Output>(async (input, ctx) => {
  // 1. Single repository mode: completely backward-compatible execution
  if (input.path !== undefined && input.path !== null) {
    return scanSingleRepo(
      {
        path: input.path,
        branch: input.branch,
      },
      ctx,
      true
    );
  }

  // 2. Batch mode: resolve repository configurations
  ctx.log.info("Starting maintenance.list in batch mode", { config: input.config });

  const configFilePath = ensureReposConfigFile({
    configPath: input.config,
    workspaceRoot: process.env.WORKSPACE_ROOT,
    log: ctx.log,
  });

  const reposToScan: RepoScanConfig[] = [];

  if (configFilePath && fs.existsSync(configFilePath)) {
    ctx.log.info("Reading batch repository configuration from file", { configFilePath });
    try {
      const rawContent = fs.readFileSync(configFilePath, "utf8");
      const parsed = JSON.parse(rawContent);
      if (!Array.isArray(parsed)) {
        ctx.log.error("Configuration file must contain an array of repositories", { configFilePath });
        return {
          batch: true,
          hasChanges: false,
          summary: { total: 0, changedCount: 0, initialCount: 0, upToDateCount: 0, errorCount: 1 },
          results: [],
          message: `Invalid configuration file: expected JSON array in ${configFilePath}`,
        };
      }
      for (const item of parsed) {
        if (typeof item === "string" && item.trim()) {
          reposToScan.push({ path: item.trim() });
        } else if (item && typeof item.path === "string" && item.path.trim()) {
          reposToScan.push({
            path: item.path.trim(),
            ...(item.repoType ? { repoType: item.repoType } : {}),
            ...(item.branch ? { branch: item.branch } : {}),
            ...(item.sourceBranch ? { branch: item.sourceBranch } : {}),
          });
        }
      }
    } catch (err: any) {
      ctx.log.error("Failed to read or parse configuration file", { configFilePath, error: err.message });
      return {
        batch: true,
        hasChanges: false,
        summary: { total: 0, changedCount: 0, initialCount: 0, upToDateCount: 0, errorCount: 1 },
        results: [],
        message: `Failed to read configuration file ${configFilePath}: ${err.message}`,
      };
    }
  }

  if (reposToScan.length === 0) {
    ctx.log.warn("No repositories found for batch scanning");
    return {
      batch: true,
      hasChanges: false,
      summary: { total: 0, changedCount: 0, initialCount: 0, upToDateCount: 0, errorCount: 0 },
      results: [],
      message: "No repositories found for batch scanning",
    };
  }

  // 3. Process each repository sequentially
  const results: NonNullable<Output["results"]> = [];
  let changedCount = 0;
  let initialCount = 0;
  let upToDateCount = 0;
  let errorCount = 0;

  for (const repoConfig of reposToScan) {
    ctx.log.info("Batch scanning repository", { path: repoConfig.path });
    const singleResult = await scanSingleRepo(
      {
        path: repoConfig.path,
        repoType: repoConfig.repoType,
        branch: repoConfig.branch ?? input.branch,
      },
      ctx,
      false
    );

    results.push(singleResult);

    if (singleResult.status === "changed") {
      changedCount++;
    } else if (singleResult.status === "initial") {
      initialCount++;
    } else if (singleResult.status === "upToDate") {
      upToDateCount++;
    } else {
      errorCount++;
    }
  }

  // 4. Determine overall hasChanges and summary
  const hasChanges = changedCount > 0 || initialCount > 0;

  const summary = {
    total: reposToScan.length,
    changedCount,
    initialCount,
    upToDateCount,
    errorCount,
  };

  let message: string;
  if (changedCount === 0 && initialCount === 0 && errorCount === 0) {
    message = `All ${upToDateCount} repositories are up to date`;
  } else {
    const parts: string[] = [];
    if (changedCount > 0) parts.push(`${changedCount} changed`);
    if (initialCount > 0) parts.push(`${initialCount} initial`);
    if (upToDateCount > 0) parts.push(`${upToDateCount} up to date`);
    if (errorCount > 0) parts.push(`${errorCount} error(s)`);
    message = `Batch scan completed: ${parts.join(", ")} across ${reposToScan.length} repositories`;
  }

  return {
    batch: true,
    hasChanges,
    summary,
    results,
    message,
  };
});
