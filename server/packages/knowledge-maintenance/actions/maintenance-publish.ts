import { defineAction } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { GitClient } from "../src/git.ts";
import { resolveRepoPath, getRepoIdentifier, detectRepoType } from "../src/repo-utils.ts";
import { MaintenanceError } from "../src/errors.ts";

export type Input = ActionInput<"maintenance.publish">;
export type Output = ActionOutput<"maintenance.publish">;

export default defineAction<Input, Output>(async (input, ctx) => {
  ctx.log.info("Starting maintenance.publish", {
    path: input.path,
    branch: input.branch,
    message: input.message,
    push: input.push,
  });

  const resolvedPath = resolveRepoPath(input.path);
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

  const repoName = await getRepoIdentifier(git, resolvedPath);
  const isInboxPath = resolvedPath.endsWith("knowledge-inbox") || resolvedPath.includes("inbox") || repoName.includes("inbox");
  const repoType = input.repoType ?? (isInboxPath ? "inbox" : await detectRepoType(git, input.branch === "docs" ? "docs" : undefined));

  // Determine target branch
  let targetBranch = input.branch ?? input.sourceBranch;
  if (!targetBranch) {
    if (repoType === "code") {
      targetBranch = "docs";
    } else {
      const curBranchRes = await git.run(["branch", "--show-current"]);
      const current = curBranchRes.stdout.trim() || (await git.run(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      if (current && current !== "HEAD") {
        targetBranch = current;
      } else {
        targetBranch = await git.getDefaultBranch();
      }
    }
  }

  const shouldPush = input.push ?? true;

  // Check porcelain status to see if there are changes
  const porcelain = await git.getPorcelainStatus();
  if (porcelain.length === 0) {
    // Check if targetBranch has unpushed commits compared to origin
    let hasUnpushedCommits = false;
    const remoteRefExists = await git.refExists(`origin/${targetBranch}`);
    if (remoteRefExists) {
      const revListRes = await git.run(["rev-list", `origin/${targetBranch}..${targetBranch}`]);
      if (revListRes.code === 0 && revListRes.stdout.trim().length > 0) {
        hasUnpushedCommits = true;
      }
    } else {
      const localBranchExists = await git.refExists(targetBranch);
      if (localBranchExists) {
        hasUnpushedCommits = true;
      }
    }

    if (hasUnpushedCommits && shouldPush) {
      ctx.log.info(`Clean working tree but detected unpushed commits on '${targetBranch}'. Pushing to origin...`);
      const pushRes = await git.run(["push", "origin", targetBranch]);
      if (pushRes.code !== 0) {
        return {
          status: "error",
          path: resolvedPath,
          repo: repoName,
          branch: targetBranch,
          committed: false,
          pushed: false,
          message: `Failed to push unpushed commits to origin/${targetBranch}: ${pushRes.stderr.trim() || pushRes.stdout.trim()}`,
        };
      }
      ctx.log.info(`Successfully pushed unpushed commits on '${targetBranch}' to origin`);
      return {
        status: "success",
        path: resolvedPath,
        repo: repoName,
        branch: targetBranch,
        committed: false,
        pushed: true,
        message: `Successfully pushed unpushed commits on '${targetBranch}' to origin/${targetBranch}`,
      };
    }

    ctx.log.info(`Working tree is clean for ${repoName}; no changes to publish`);
    return {
      status: "no_changes",
      path: resolvedPath,
      repo: repoName,
      branch: targetBranch,
      committed: false,
      pushed: false,
      message: `Working tree is clean in ${repoName}; no changes to publish`,
    };
  }

  // Ensure we are on the target branch
  const curBranchRes = await git.run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const currentBranch = curBranchRes.stdout.trim();
  if (currentBranch !== targetBranch) {
    ctx.log.info(`Current branch '${currentBranch}' differs from target '${targetBranch}'. Checking out '${targetBranch}'...`);
    const branchExists = await git.refExists(targetBranch);
    if (branchExists) {
      const checkoutRes = await git.run(["checkout", targetBranch]);
      if (checkoutRes.code !== 0) {
        return {
          status: "error",
          path: resolvedPath,
          repo: repoName,
          branch: targetBranch,
          committed: false,
          pushed: false,
          message: `Failed to checkout target branch '${targetBranch}': ${checkoutRes.stderr.trim() || checkoutRes.stdout.trim()}`,
        };
      }
    } else {
      const remoteExists = await git.refExists(`origin/${targetBranch}`);
      const checkoutRes = remoteExists
        ? await git.run(["checkout", "-b", targetBranch, `origin/${targetBranch}`])
        : await git.run(["checkout", "-b", targetBranch]);
      if (checkoutRes.code !== 0) {
        return {
          status: "error",
          path: resolvedPath,
          repo: repoName,
          branch: targetBranch,
          committed: false,
          pushed: false,
          message: `Failed to create/checkout branch '${targetBranch}': ${checkoutRes.stderr.trim() || checkoutRes.stdout.trim()}`,
        };
      }
    }
  }

  // Stage changes
  if (input.files && input.files.length > 0) {
    const addRes = await git.run(["add", "--", ...input.files]);
    if (addRes.code !== 0) {
      return {
        status: "error",
        path: resolvedPath,
        repo: repoName,
        branch: targetBranch,
        committed: false,
        pushed: false,
        message: `Failed to stage specified files: ${addRes.stderr.trim() || addRes.stdout.trim()}`,
      };
    }
  } else {
    const addRes = await git.run(["add", "-A"]);
    if (addRes.code !== 0) {
      return {
        status: "error",
        path: resolvedPath,
        repo: repoName,
        branch: targetBranch,
        committed: false,
        pushed: false,
        message: `Failed to stage changes: ${addRes.stderr.trim() || addRes.stdout.trim()}`,
      };
    }
  }

  // Verify staged changes exist
  const stagedDiff = await git.run(["diff", "--cached", "--name-only"]);
  const stagedFiles = stagedDiff.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (stagedFiles.length === 0) {
    return {
      status: "no_changes",
      path: resolvedPath,
      repo: repoName,
      branch: targetBranch,
      committed: false,
      pushed: false,
      message: "No staged changes detected after git add; nothing to commit",
    };
  }

  // Commit
  const commitMsg = input.message?.trim() || "docs: update knowledge documentation";
  const authorName = ctx.config.get<string>("GIT_AUTHOR_NAME") || process.env.GIT_AUTHOR_NAME || "Knowledge Maintainer";
  const authorEmail = ctx.config.get<string>("GIT_AUTHOR_EMAIL") || process.env.GIT_AUTHOR_EMAIL || "maintainer@actiondock.local";
  const committerName = process.env.GIT_COMMITTER_NAME || authorName;
  const committerEmail = process.env.GIT_COMMITTER_EMAIL || authorEmail;

  ctx.log.info(`Committing ${stagedFiles.length} file(s) with message: "${commitMsg}"...`);
  const commitRes = await git.run(["commit", "-m", commitMsg], {
    env: {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: committerName,
      GIT_COMMITTER_EMAIL: committerEmail,
    },
  });

  if (commitRes.code !== 0) {
    return {
      status: "error",
      path: resolvedPath,
      repo: repoName,
      branch: targetBranch,
      committed: false,
      pushed: false,
      message: `Failed to commit changes: ${commitRes.stderr.trim() || commitRes.stdout.trim()}`,
    };
  }

  const currentCommit = await git.getHeadCommit();
  ctx.log.info(`Successfully created commit ${currentCommit}`);

  // Push to remote origin
  let pushed = false;
  if (shouldPush) {
    ctx.log.info(`Pushing branch '${targetBranch}' to remote origin...`);
    const pushRes = await git.run(["push", "origin", targetBranch]);
    if (pushRes.code !== 0) {
      return {
        status: "error",
        path: resolvedPath,
        repo: repoName,
        branch: targetBranch,
        committed: true,
        pushed: false,
        commit: currentCommit,
        files: stagedFiles,
        message: `Committed ${currentCommit} but failed to push to origin/${targetBranch}: ${pushRes.stderr.trim() || pushRes.stdout.trim()}`,
      };
    }
    pushed = true;
    ctx.log.info(`Successfully pushed ${targetBranch} to origin`);
  }

  return {
    status: "success",
    path: resolvedPath,
    repo: repoName,
    branch: targetBranch,
    committed: true,
    pushed,
    commit: currentCommit,
    files: stagedFiles,
    message: `Successfully committed ${currentCommit} and ${pushed ? `pushed to origin/${targetBranch}` : "saved locally"} (${stagedFiles.length} files)`,
  };
});
