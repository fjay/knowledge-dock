import { defineAction, encodeStateKey } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { GitClient } from "../src/git.ts";
import { resolveRepoPath, getRepoIdentifier } from "../src/repo-utils.ts";
import { MaintenanceError } from "../src/errors.ts";

export type Input = ActionInput<"maintenance.complete">;
export type Output = ActionOutput<"maintenance.complete">;

const HEX_COMMIT_REGEX = /^[0-9a-fA-F]{7,40}$/;

export default defineAction<Input, Output>(async (input, ctx) => {
  ctx.log.info("Starting maintenance.complete", {
    path: input.path,
    commit: input.commit,
    actionTaken: input.actionTaken,
  });

  const resolvedPath = resolveRepoPath(input.path);
  const rawCommit = input.commit?.trim();

  // 1. Validate commit hash format
  if (!rawCommit || !HEX_COMMIT_REGEX.test(rawCommit)) {
    throw new MaintenanceError(
      `Invalid commit hash format: '${input.commit}'. Must be a 7-40 hex character hash.`,
      "INVALID_COMMIT_HASH",
      400
    );
  }

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

  // 2. Validate commit exists in the repository
  const fullCommit = await git.verifyCommitExists(rawCommit);
  const repoName = await getRepoIdentifier(git, resolvedPath);

  // 3. Read previous checkpoint from ctx.state
  const stateKey = encodeStateKey("checkpoints", repoName);
  const savedState = await ctx.state.get<any>(stateKey);
  const previousCommit: string | null =
    savedState && typeof savedState.commit === "string" ? savedState.commit : null;

  // 4. Update checkpoint in state
  const updatedAt = new Date().toISOString();
  const actionTaken = input.actionTaken ?? "no_change_needed";
  const summary = input.summary ?? "";

  const record = {
    commit: fullCommit,
    actionTaken,
    summary,
    updatedAt,
    repo: repoName,
    path: resolvedPath,
  };

  await ctx.state.set(stateKey, record);

  ctx.log.info(`Updated checkpoint for repository ${repoName}`, {
    repo: repoName,
    previousCommit,
    currentCommit: fullCommit,
    actionTaken,
    summary,
  });

  return {
    repo: repoName,
    path: resolvedPath,
    previousCommit,
    currentCommit: fullCommit,
    actionTaken,
    summary,
    updatedAt,
  };
});
