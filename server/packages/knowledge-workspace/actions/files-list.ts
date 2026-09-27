import fs from "node:fs";
import path from "node:path";
import { defineAction } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { WorkspacePathPolicy } from "../src/path-policy.ts";
import { isSensitivePath } from "../src/file-policy.ts";
import {
  DEFAULT_LIST_DEPTH,
  MAX_LIST_DEPTH,
  MAX_LIST_ENTRIES,
} from "../src/limits.ts";
import { WorkspaceError } from "../src/errors.ts";

export type Input = ActionInput<"files.list">;
export type Output = ActionOutput<"files.list">;

interface QueueItem {
  dirAbsolute: string;
  currentDepth: number;
}

export default defineAction<Input, Output>(async (input, ctx) => {
  const workspaceRoot = ctx.config.get<string>("WORKSPACE_ROOT", process.cwd());
  const pathPolicy = new WorkspacePathPolicy(workspaceRoot);

  const targetPath = input.path || "";
  const resolved = pathPolicy.resolveAndValidate(targetPath);

  if (!resolved.stat || !resolved.stat.isDirectory()) {
    throw new WorkspaceError(
      `Path is not a directory: ${targetPath}`,
      "NOT_A_DIRECTORY",
      400
    );
  }

  const maxDepth = Math.min(
    Math.max(1, Math.floor(input.depth ?? DEFAULT_LIST_DEPTH)),
    MAX_LIST_DEPTH
  );
  const includeHidden = Boolean(input.hidden);

  const items: Array<{
    path: string;
    type: "file" | "directory";
    sizeBytes?: number;
  }> = [];

  let truncated = false;
  const queue: QueueItem[] = [{ dirAbsolute: resolved.absolutePath, currentDepth: 1 }];

  while (queue.length > 0) {
    if (ctx.signal.aborted) {
      throw new Error("List operation aborted by caller");
    }

    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dirAbsolute, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith(".")) {
        continue;
      }

      const entryAbsolute = path.join(current.dirAbsolute, entry.name);
      const entryRel = pathPolicy.toRelativePath(entryAbsolute);

      // Filter out sensitive files and directories (Section 23)
      if (isSensitivePath(entryRel)) {
        continue;
      }

      // Check symlink boundary safety (Section 22)
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      let fileSize: number | undefined;

      if (entry.isSymbolicLink()) {
        try {
          const symRes = pathPolicy.resolveAndValidate(entryRel);
          if (symRes.stat?.isDirectory()) {
            isDir = true;
          } else if (symRes.stat?.isFile()) {
            isFile = true;
            fileSize = symRes.stat.size;
          }
        } catch {
          // Symlink escaping workspace or broken -> skip
          continue;
        }
      } else if (isFile) {
        try {
          const st = fs.statSync(entryAbsolute);
          fileSize = st.size;
        } catch {
          fileSize = undefined;
        }
      }

      if (isDir) {
        items.push({
          path: entryRel,
          type: "directory",
        });

        if (current.currentDepth < maxDepth) {
          queue.push({
            dirAbsolute: entryAbsolute,
            currentDepth: current.currentDepth + 1,
          });
        }
      } else if (isFile) {
        items.push({
          path: entryRel,
          type: "file",
          ...(fileSize !== undefined ? { sizeBytes: fileSize } : {}),
        });
      }

      if (items.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        break;
      }
    }

    if (truncated) {
      break;
    }
  }

  // Recommended sorting: directory first, filename ascending (Section 29)
  items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    return a.path.localeCompare(b.path);
  });

  return {
    items,
    truncated,
  };
});
