import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitLogger {
  info?: (msg: string, meta?: any) => void;
  warn?: (msg: string, meta?: any) => void;
  error?: (msg: string, meta?: any) => void;
}

/**
 * Checks whether the given directory is inside a Git working tree.
 */
export async function isInsideGitWorkTree(dirPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dirPath,
      timeout: 5000,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Commits a newly collected candidate document if inboxRoot is a Git repository.
 * Gracefully degrades with a warning log if not a Git repository or if commit fails.
 */
export async function commitCandidateCollect(
  inboxRoot: string,
  filename: string,
  candidateId: string,
  title: string,
  logger?: GitLogger
): Promise<boolean> {
  try {
    const isGit = await isInsideGitWorkTree(inboxRoot);
    if (!isGit) {
      return false;
    }

    const relFilePath = `pending/${filename}`;
    const cleanTitle = (title || "").replace(/[\r\n]+/g, " ").trim();
    const commitMsg = cleanTitle
      ? `feat(inbox): collect candidate ${candidateId} - ${cleanTitle}`
      : `feat(inbox): collect candidate ${candidateId}`;

    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "Knowledge Maintainer",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "maintainer@actiondock.local",
      GIT_COMMITTER_NAME:
        process.env.GIT_COMMITTER_NAME ||
        process.env.GIT_AUTHOR_NAME ||
        "Knowledge Maintainer",
      GIT_COMMITTER_EMAIL:
        process.env.GIT_COMMITTER_EMAIL ||
        process.env.GIT_AUTHOR_EMAIL ||
        "maintainer@actiondock.local",
    };

    await execFileAsync("git", ["add", relFilePath], {
      cwd: inboxRoot,
      timeout: 10000,
      env,
    });

    await execFileAsync("git", ["commit", "-m", commitMsg], {
      cwd: inboxRoot,
      timeout: 10000,
      env,
    });

    logger?.info?.("Git committed collected candidate document", {
      candidateId,
      filename,
      commitMsg,
    });

    return true;
  } catch (err: any) {
    logger?.warn?.("Failed to git commit collected candidate document; gracefully degrading", {
      candidateId,
      filename,
      error: err?.message,
    });
    return false;
  }
}

/**
 * Commits an archived candidate document if inboxRoot is a Git repository.
 * Gracefully degrades with a warning log if not a Git repository or if commit fails.
 */
export async function commitCandidateArchive(
  inboxRoot: string,
  candidateId: string,
  resolution: string,
  logger?: GitLogger
): Promise<boolean> {
  try {
    const isGit = await isInsideGitWorkTree(inboxRoot);
    if (!isGit) {
      return false;
    }

    const commitMsg = `chore(inbox): archive candidate ${candidateId} as ${resolution}`;

    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "Knowledge Maintainer",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "maintainer@actiondock.local",
      GIT_COMMITTER_NAME:
        process.env.GIT_COMMITTER_NAME ||
        process.env.GIT_AUTHOR_NAME ||
        "Knowledge Maintainer",
      GIT_COMMITTER_EMAIL:
        process.env.GIT_COMMITTER_EMAIL ||
        process.env.GIT_AUTHOR_EMAIL ||
        "maintainer@actiondock.local",
    };

    await execFileAsync("git", ["add", "pending/", "processed/"], {
      cwd: inboxRoot,
      timeout: 10000,
      env,
    });

    await execFileAsync("git", ["commit", "-m", commitMsg], {
      cwd: inboxRoot,
      timeout: 10000,
      env,
    });

    logger?.info?.("Git committed archived candidate document", {
      candidateId,
      resolution,
      commitMsg,
    });

    return true;
  } catch (err: any) {
    logger?.warn?.("Failed to git commit archived candidate document; gracefully degrading", {
      candidateId,
      resolution,
      error: err?.message,
    });
    return false;
  }
}
