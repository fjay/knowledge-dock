import fs from "node:fs";
import readline from "node:readline";
import { defineAction } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { WorkspacePathPolicy } from "../src/path-policy.ts";
import { validateUtf8File } from "../src/file-policy.ts";
import {
  DEFAULT_READ_LINES,
  MAX_READ_LINES,
  MAX_READ_BYTES,
} from "../src/limits.ts";
import { WorkspaceError } from "../src/errors.ts";

export type Input = ActionInput<"files.read">;
export type Output = ActionOutput<"files.read">;


export default defineAction<Input, Output>(async (input, ctx) => {
  const workspaceRoot = ctx.config.get<string>("WORKSPACE_ROOT", process.cwd());
  const pathPolicy = new WorkspacePathPolicy(workspaceRoot);

  const resolved = pathPolicy.resolveAndValidate(input.path);
  if (!resolved.stat || !resolved.stat.isFile()) {
    throw new WorkspaceError(
      `Path is not a regular file: ${input.path}`,
      "NOT_A_FILE",
      400
    );
  }

  validateUtf8File(resolved.absolutePath, resolved.stat.size);

  const startLine = Math.max(1, Math.floor(input.startLine ?? 1));
  const effectiveMaxLines = Math.min(
    Math.max(1, Math.floor(input.maxLines ?? DEFAULT_READ_LINES)),
    MAX_READ_LINES
  );

  const collectedLines: string[] = [];
  let currentLine = 0;
  let totalBytes = 0;
  let hasMore = false;
  let truncated = false;

  const fileStream = fs.createReadStream(resolved.absolutePath, {
    encoding: "utf8",
  });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (ctx.signal.aborted) {
        throw new Error("Read operation aborted by caller");
      }

      currentLine++;

      if (currentLine < startLine) {
        continue;
      }

      if (collectedLines.length >= effectiveMaxLines) {
        hasMore = true;
        break;
      }

      const lineBytes = Buffer.byteLength(line, "utf8") + 1; // account for newline
      if (totalBytes + lineBytes > MAX_READ_BYTES) {
        truncated = true;
        hasMore = true;
        break;
      }

      collectedLines.push(line);
      totalBytes += lineBytes;
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }

  const endLine =
    collectedLines.length > 0
      ? startLine + collectedLines.length - 1
      : startLine;

  return {
    path: resolved.relativePath,
    startLine,
    endLine,
    content: collectedLines.join("\n"),
    hasMore,
    ...(truncated ? { truncated: true } : {}),
  };
});
