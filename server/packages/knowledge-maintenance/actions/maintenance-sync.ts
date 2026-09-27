import fs from "node:fs";
import path from "node:path";
import { defineAction, type ActionContext } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { GitClient } from "../src/git.ts";
import { resolveRepoPath, detectRepoType, ensureReposConfigFile } from "../src/repo-utils.ts";
import { DEFAULT_GIT_CLONE_TIMEOUT_MS } from "../src/limits.ts";

export type Input = ActionInput<"maintenance.sync">;
export type Output = ActionOutput<"maintenance.sync">;

interface RepoSyncConfig {
  path: string;
  url?: string;
  repoType?: "code" | "system_knowledge";
  sourceBranch?: string;
  knowledgeBranch?: string;
  filterBlobNone?: boolean;
  cloneTimeoutMs?: number;
}

type SingleRepoResult = {
  status: "success" | "dirty_worktree" | "conflict" | "error";
  path: string;
  cloned?: boolean;
  repoType?: "code" | "system_knowledge";
  sourceBranch?: string;
  knowledgeBranch?: string;
  currentCommit?: string;
  uncommittedFiles?: string[];
  conflictFiles?: string[];
  initializedBranch?: boolean;
  message: string;
};

/**
 * Synchronizes a single repository according to its architecture type (code dual-branch or system_knowledge single-branch).
 */
async function syncSingleRepo(
  repoInput: RepoSyncConfig,
  ctx: ActionContext
): Promise<SingleRepoResult> {
  ctx.log.info("Starting maintenance.sync for repository", { path: repoInput.path });

  let resolvedPath: string;
  try {
    resolvedPath = resolveRepoPath(repoInput.path, { allowNonExistent: true });
  } catch (err: any) {
    ctx.log.error("Failed to resolve repository path", { error: err.message });
    return {
      status: "error",
      path: repoInput.path,
      cloned: false,
      ...(repoInput.repoType ? { repoType: repoInput.repoType } : { repoType: "code" as const }),
      message: err.message,
    };
  }

  const timeoutMs = ctx.config.get<number>("GIT_TIMEOUT_MS", 30000);
  const cloneTimeoutMs =
    repoInput.cloneTimeoutMs ?? ctx.config.get<number>("GIT_CLONE_TIMEOUT_MS", DEFAULT_GIT_CLONE_TIMEOUT_MS);
  const maxOutputBytes = ctx.config.get<number>("GIT_MAX_OUTPUT_BYTES", 4 * 1024 * 1024);
  const defaultBlobless = ctx.config.get<boolean>("GIT_BLOBLESS_FETCH", true);
  const useBlobless = repoInput.filterBlobNone ?? defaultBlobless;

  let cloned = false;
  const pathExists = fs.existsSync(resolvedPath);
  const hasGitDir = pathExists && fs.existsSync(path.join(resolvedPath, ".git"));

  if (!pathExists || (!hasGitDir && repoInput.url)) {
    if (!repoInput.url) {
      ctx.log.error("Target path does not exist and no remote url provided for clone", { path: resolvedPath });
      return {
        status: "error",
        path: resolvedPath,
        cloned: false,
        ...(repoInput.repoType ? { repoType: repoInput.repoType } : { repoType: "code" as const }),
        message: `Target path does not exist and no remote url provided for clone: ${resolvedPath}`,
      };
    }

    ctx.log.info("Target repository does not exist locally; initiating clone", {
      path: resolvedPath,
      url: repoInput.url,
      useBlobless,
    });

    const cloneRes = await GitClient.clone(ctx, repoInput.url, resolvedPath, {
      filterBlobNone: useBlobless,
      branch: repoInput.sourceBranch,
      timeoutMs: cloneTimeoutMs,
      maxOutputBytes,
    });

    if (cloneRes.code !== 0) {
      const errorMsg = cloneRes.stderr.trim() || cloneRes.stdout.trim() || "git clone failed";
      ctx.log.error("git clone failed", { error: errorMsg });
      return {
        status: "error",
        path: resolvedPath,
        cloned: false,
        ...(repoInput.repoType ? { repoType: repoInput.repoType } : { repoType: "code" as const }),
        message: `Failed to clone repository from ${repoInput.url}: ${errorMsg}`,
      };
    }

    cloned = true;
  }

  const git = new GitClient(ctx, resolvedPath, timeoutMs, maxOutputBytes);

  // 1. Validate git repository
  const isWorkTree = await git.isInsideWorkTree();
  if (!isWorkTree) {
    ctx.log.error("Target path is not a valid git repository", { path: resolvedPath });
    return {
      status: "error",
      path: resolvedPath,
      cloned,
      ...(repoInput.repoType ? { repoType: repoInput.repoType } : { repoType: "code" as const }),
      message: `Path is not a valid git repository: ${resolvedPath}`,
    };
  }

  // 2. Check clean worktree
  const dirtyFiles = await git.getPorcelainStatus();
  if (dirtyFiles.length > 0) {
    ctx.log.warn("Working tree has uncommitted modifications; aborting sync", {
      dirtyCount: dirtyFiles.length,
      files: dirtyFiles,
    });
    return {
      status: "dirty_worktree",
      path: resolvedPath,
      cloned,
      ...(repoInput.repoType ? { repoType: repoInput.repoType } : { repoType: "code" as const }),
      uncommittedFiles: dirtyFiles,
      message: "Working tree is dirty; synchronization aborted to prevent uncommitted changes from being lost",
    };
  }

  // 3. Resolve repository type and branch configurations
  const repoType = repoInput.repoType ?? (await detectRepoType(git, repoInput.knowledgeBranch));
  const sourceBranch = repoInput.sourceBranch ?? (repoType === "code" ? "release" : "master");
  const knowledgeBranch = repoType === "code" ? (repoInput.knowledgeBranch ?? "docs") : undefined;

  ctx.log.info(`Syncing repository (${repoType})`, {
    resolvedPath,
    repoType,
    sourceBranch,
    ...(knowledgeBranch ? { knowledgeBranch } : {}),
  });

  // Ensure production source branch is checked out if newly cloned
  if (cloned) {
    const localSourceExists = await git.refExists(`refs/heads/${sourceBranch}`);
    if (localSourceExists) {
      await git.run(["checkout", sourceBranch]);
    } else {
      const originSourceExists = await git.refExists(`origin/${sourceBranch}`);
      if (originSourceExists) {
        await git.run(["checkout", "-B", sourceBranch, `origin/${sourceBranch}`]);
      }
    }
  }

  // 4. Fetch origin (Blobless Partial Fetch with automatic fallback)
  ctx.log.info(`Fetching from remote origin (blobless: ${useBlobless})...`);
  const fetchResult = await git.fetchOrigin({ filterBlobNone: useBlobless });
  if (fetchResult.code !== 0) {
    const errorMsg = fetchResult.stderr.trim() || fetchResult.stdout.trim() || "git fetch origin failed";
    ctx.log.error("git fetch origin failed", { error: errorMsg });
    return {
      status: "error",
      path: resolvedPath,
      cloned,
      repoType,
      sourceBranch,
      ...(knowledgeBranch ? { knowledgeBranch } : {}),
      message: `Failed to fetch from remote origin: ${errorMsg}`,
    };
  }

  // 5A. Single branch / system knowledge repository
  if (repoType === "system_knowledge") {
    ctx.log.info(`Switching to ${sourceBranch} for system_knowledge sync...`);
    const localBranchExists = await git.refExists(`refs/heads/${sourceBranch}`);
    if (localBranchExists) {
      const checkoutRes = await git.run(["checkout", sourceBranch]);
      if (checkoutRes.code !== 0) {
        return {
          status: "error",
          path: resolvedPath,
          cloned,
          repoType,
          sourceBranch,
          message: `Failed to checkout ${sourceBranch}: ${checkoutRes.stderr.trim()}`,
        };
      }
    } else {
      const checkoutRes = await git.run(["checkout", "-B", sourceBranch, `origin/${sourceBranch}`]);
      if (checkoutRes.code !== 0) {
        return {
          status: "error",
          path: resolvedPath,
          cloned,
          repoType,
          sourceBranch,
          message: `Failed to checkout ${sourceBranch} from origin/${sourceBranch}: ${checkoutRes.stderr.trim()}`,
        };
      }
    }

    ctx.log.info(`Fast-forward merging origin/${sourceBranch}...`);
    const mergeRes = await git.run(["merge", "--ff-only", `origin/${sourceBranch}`]);
    if (mergeRes.code !== 0) {
      const err = mergeRes.stderr.trim() || mergeRes.stdout.trim();
      ctx.log.error("Fast-forward merge failed", { error: err });
      return {
        status: "error",
        path: resolvedPath,
        cloned,
        repoType,
        sourceBranch,
        message: `Fast-forward merge failed for origin/${sourceBranch}: ${err}`,
      };
    }

    const currentCommit = await git.getHeadCommit();
    ctx.log.info(`Successfully synced ${sourceBranch} to ${currentCommit}`);

    return {
      status: "success",
      path: resolvedPath,
      cloned,
      repoType,
      sourceBranch,
      currentCommit,
      message: `Successfully synchronized system knowledge branch '${sourceBranch}' via fast-forward merge`,
    };
  }

  // 5B. Dual-branch code repository (release -> docs)
  const docsBranch = knowledgeBranch!;
  const remoteDocsExists = await git.refExists(`origin/${docsBranch}`);

  if (!remoteDocsExists) {
    ctx.log.info(`Remote branch origin/${docsBranch} does not exist. Initializing from origin/${sourceBranch}...`);
    const localDocsExists = await git.refExists(`refs/heads/${docsBranch}`);
    if (localDocsExists) {
      const checkoutRes = await git.run(["checkout", docsBranch]);
      if (checkoutRes.code !== 0) {
        return {
          status: "error",
          path: resolvedPath,
          cloned,
          repoType,
          sourceBranch,
          knowledgeBranch: docsBranch,
          message: `Failed to checkout ${docsBranch}: ${checkoutRes.stderr.trim()}`,
        };
      }
    } else {
      const checkoutRes = await git.run(["checkout", "-b", docsBranch, `origin/${sourceBranch}`]);
      if (checkoutRes.code !== 0) {
        return {
          status: "error",
          path: resolvedPath,
          cloned,
          repoType,
          sourceBranch,
          knowledgeBranch: docsBranch,
          message: `Failed to create local ${docsBranch} branch: ${checkoutRes.stderr.trim()}`,
        };
      }
    }

    ctx.log.info(`Pushing newly created ${docsBranch} to origin...`);
    const pushRes = await git.run(["push", "origin", docsBranch]);
    if (pushRes.code !== 0) {
      return {
        status: "error",
        path: resolvedPath,
        cloned,
        repoType,
        sourceBranch,
        knowledgeBranch: docsBranch,
        message: `Failed to push initialized ${docsBranch} to origin: ${pushRes.stderr.trim()}`,
      };
    }

    const currentCommit = await git.getHeadCommit();
    return {
      status: "success",
      path: resolvedPath,
      cloned,
      repoType,
      sourceBranch,
      knowledgeBranch: docsBranch,
      currentCommit,
      initializedBranch: true,
      message: `Initialized knowledge branch '${docsBranch}' from 'origin/${sourceBranch}' and pushed to remote origin`,
    };
  }

  // Remote docs branch exists: switch and fast-forward local docs if needed
  ctx.log.info(`Switching to knowledge branch ${docsBranch}...`);
  const localDocsExists = await git.refExists(`refs/heads/${docsBranch}`);
  if (localDocsExists) {
    const checkoutRes = await git.run(["checkout", docsBranch]);
    if (checkoutRes.code !== 0) {
      return {
        status: "error",
        path: resolvedPath,
        cloned,
        repoType,
        sourceBranch,
        knowledgeBranch: docsBranch,
        message: `Failed to checkout ${docsBranch}: ${checkoutRes.stderr.trim()}`,
      };
    }
    // Bring local docs up to date with origin/docs
    const ffRes = await git.run(["merge", "--ff-only", `origin/${docsBranch}`]);
    if (ffRes.code !== 0) {
      return {
        status: "error",
        path: resolvedPath,
        cloned,
        repoType,
        sourceBranch,
        knowledgeBranch: docsBranch,
        message: `Failed to fast-forward ${docsBranch} to origin/${docsBranch} (local branch may have diverged): ${ffRes.stderr.trim() || ffRes.stdout.trim()}`,
      };
    }
  } else {
    const checkoutRes = await git.run(["checkout", "-b", docsBranch, `origin/${docsBranch}`]);
    if (checkoutRes.code !== 0) {
      return {
        status: "error",
        path: resolvedPath,
        cloned,
        repoType,
        sourceBranch,
        knowledgeBranch: docsBranch,
        message: `Failed to checkout ${docsBranch} tracking origin/${docsBranch}: ${checkoutRes.stderr.trim()}`,
      };
    }
  }

  // Merge origin/<sourceBranch> into knowledgeBranch
  ctx.log.info(`Merging origin/${sourceBranch} into ${docsBranch}...`);
  const mergeRes = await git.run(["merge", "--no-edit", `origin/${sourceBranch}`]);

  if (mergeRes.code !== 0) {
    ctx.log.warn(`Merge conflict detected while merging origin/${sourceBranch} into ${docsBranch}`);

    // Read conflict files before aborting merge
    const statusRes = await git.run(["status", "--porcelain"]);
    const conflictFiles = statusRes.stdout
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => /^(UU|AA|UD|DU|DD|AU|UA)/.test(line))
      .map((line: string) => line.slice(3).trim())
      .filter(Boolean);

    ctx.log.info("Safely aborting merge via git merge --abort...");
    await git.run(["merge", "--abort"]);

    return {
      status: "conflict",
      path: resolvedPath,
      cloned,
      repoType,
      sourceBranch,
      knowledgeBranch: docsBranch,
      conflictFiles: conflictFiles.length > 0 ? conflictFiles : ["(conflicting files undetected)"],
      message: `Merge conflict detected while merging origin/${sourceBranch} into ${docsBranch}; merge was safely aborted`,
    };
  }

  // Push merged knowledge branch to remote origin
  ctx.log.info(`Pushing updated ${docsBranch} to origin...`);
  const pushRes = await git.run(["push", "origin", docsBranch]);
  if (pushRes.code !== 0) {
    return {
      status: "error",
      path: resolvedPath,
      cloned,
      repoType,
      sourceBranch,
      knowledgeBranch: docsBranch,
      message: `Merged origin/${sourceBranch} but failed to push ${docsBranch} to origin: ${pushRes.stderr.trim()}`,
    };
  }

  const currentCommit = await git.getHeadCommit();
  ctx.log.info(`Successfully merged origin/${sourceBranch} into ${docsBranch} at ${currentCommit}`);

  return {
    status: "success",
    path: resolvedPath,
    cloned,
    repoType,
    sourceBranch,
    knowledgeBranch: docsBranch,
    currentCommit,
    initializedBranch: false,
    message: `Successfully synchronized '${sourceBranch}' into '${docsBranch}' and pushed to remote origin`,
  };
}

export default defineAction<Input, Output>(async (input, ctx) => {
  // 1. Single repository mode: completely backward-compatible execution
  if (input.path !== undefined && input.path !== null) {
    return syncSingleRepo(
      {
        path: input.path,
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.repoType !== undefined ? { repoType: input.repoType } : {}),
        ...(input.sourceBranch !== undefined ? { sourceBranch: input.sourceBranch } : {}),
        ...(input.knowledgeBranch !== undefined ? { knowledgeBranch: input.knowledgeBranch } : {}),
        ...(input.filterBlobNone !== undefined ? { filterBlobNone: input.filterBlobNone } : {}),
        ...(input.cloneTimeoutMs !== undefined ? { cloneTimeoutMs: input.cloneTimeoutMs } : {}),
      },
      ctx
    );
  }

  // 2. Batch mode: resolve repository configurations
  ctx.log.info("Starting maintenance.sync in batch mode", { config: input.config });

  const configFilePath = ensureReposConfigFile({
    configPath: input.config,
    workspaceRoot: process.env.WORKSPACE_ROOT,
    log: ctx.log,
  });

  const reposToSync: RepoSyncConfig[] = [];

  if (configFilePath && fs.existsSync(configFilePath)) {
    ctx.log.info("Reading batch repository configuration from file", { configFilePath });
    try {
      const rawContent = fs.readFileSync(configFilePath, "utf8");
      const parsed = JSON.parse(rawContent);
      if (!Array.isArray(parsed)) {
        ctx.log.error("Configuration file must contain an array of repositories", { configFilePath });
        return {
          batch: true,
          status: "error",
          summary: { total: 0, syncedCount: 0, conflictCount: 0, errorCount: 1 },
          results: [],
          conflicts: [],
          message: `Invalid configuration file: expected JSON array in ${configFilePath}`,
        };
      }
      for (const item of parsed) {
        if (typeof item === "string" && item.trim()) {
          reposToSync.push({ path: item.trim() });
        } else if (item && typeof item.path === "string" && item.path.trim()) {
          reposToSync.push({
            path: item.path.trim(),
            ...(item.url && typeof item.url === "string" ? { url: item.url.trim() } : {}),
            ...(item.repoType ? { repoType: item.repoType } : {}),
            ...(item.sourceBranch ? { sourceBranch: item.sourceBranch } : {}),
            ...(item.knowledgeBranch ? { knowledgeBranch: item.knowledgeBranch } : {}),
            ...(item.filterBlobNone !== undefined ? { filterBlobNone: item.filterBlobNone } : {}),
            ...(typeof item.cloneTimeoutMs === "number" ? { cloneTimeoutMs: item.cloneTimeoutMs } : {}),
          });
        }
      }
    } catch (err: any) {
      ctx.log.error("Failed to read or parse configuration file", { configFilePath, error: err.message });
      return {
        batch: true,
        status: "error",
        summary: { total: 0, syncedCount: 0, conflictCount: 0, errorCount: 1 },
        results: [],
        conflicts: [],
        message: `Failed to read configuration file ${configFilePath}: ${err.message}`,
      };
    }
  }

  if (reposToSync.length === 0) {
    ctx.log.warn("No repositories found for batch synchronization");
    return {
      batch: true,
      status: "error",
      summary: { total: 0, syncedCount: 0, conflictCount: 0, errorCount: 0 },
      results: [],
      conflicts: [],
      message: "No repositories found for batch synchronization",
    };
  }

  // 3. Process each repository sequentially
  const results: NonNullable<Output["results"]> = [];
  const conflicts: NonNullable<Output["conflicts"]> = [];
  let syncedCount = 0;
  let conflictCount = 0;
  let errorCount = 0;

  for (const repoConfig of reposToSync) {
    ctx.log.info("Batch synchronizing repository", { path: repoConfig.path });
    try {
      // url 是每仓唯一身份，批量模式下不继承顶层 input.url，避免误用同一远端克隆全部仓库
      const singleResult = await syncSingleRepo(
        {
          path: repoConfig.path,
          ...(repoConfig.url !== undefined ? { url: repoConfig.url } : {}),
          ...(repoConfig.repoType !== undefined
            ? { repoType: repoConfig.repoType }
            : input.repoType !== undefined
            ? { repoType: input.repoType }
            : {}),
          ...(repoConfig.sourceBranch !== undefined
            ? { sourceBranch: repoConfig.sourceBranch }
            : input.sourceBranch !== undefined
            ? { sourceBranch: input.sourceBranch }
            : {}),
          ...(repoConfig.knowledgeBranch !== undefined
            ? { knowledgeBranch: repoConfig.knowledgeBranch }
            : input.knowledgeBranch !== undefined
            ? { knowledgeBranch: input.knowledgeBranch }
            : {}),
          ...(repoConfig.filterBlobNone !== undefined
            ? { filterBlobNone: repoConfig.filterBlobNone }
            : input.filterBlobNone !== undefined
            ? { filterBlobNone: input.filterBlobNone }
            : {}),
          ...(repoConfig.cloneTimeoutMs !== undefined
            ? { cloneTimeoutMs: repoConfig.cloneTimeoutMs }
            : input.cloneTimeoutMs !== undefined
            ? { cloneTimeoutMs: input.cloneTimeoutMs }
            : {}),
        },
        ctx
      );

      results.push(singleResult);

      if (singleResult.status === "success") {
        syncedCount++;
      } else if (singleResult.status === "conflict") {
        conflictCount++;
        conflicts.push({
          path: singleResult.path,
          ...(singleResult.sourceBranch ? { sourceBranch: singleResult.sourceBranch } : {}),
          ...(singleResult.knowledgeBranch ? { knowledgeBranch: singleResult.knowledgeBranch } : {}),
          conflictFiles: singleResult.conflictFiles ?? [],
        });
      } else {
        errorCount++;
      }
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      ctx.log.error("Unexpected error syncing repository in batch", { path: repoConfig.path, error: errorMsg });
      results.push({
        status: "error",
        path: repoConfig.path,
        ...(repoConfig.repoType ? { repoType: repoConfig.repoType } : {}),
        message: errorMsg,
      });
      errorCount++;
    }
  }

  // 4. Determine overall status and summary
  let overallStatus: "success" | "conflict" | "error";
  if (conflictCount > 0) {
    overallStatus = "conflict";
  } else if (errorCount > 0) {
    overallStatus = "error";
  } else {
    overallStatus = "success";
  }

  const summary = {
    total: reposToSync.length,
    syncedCount,
    conflictCount,
    errorCount,
  };

  let message: string;
  if (overallStatus === "success") {
    message = `Successfully synchronized all ${syncedCount} repositories`;
  } else if (overallStatus === "conflict") {
    message = `Batch synchronization encountered merge conflicts in ${conflictCount} repository(ies)`;
  } else {
    message = `Batch synchronization completed with ${errorCount} error(s) out of ${reposToSync.length} repositories`;
  }

  return {
    batch: true,
    status: overallStatus,
    summary,
    results,
    conflicts,
    message,
  };
});

