import fs from "node:fs";
import path from "node:path";
import { defineAction } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { WorkspacePathPolicy } from "../src/path-policy.ts";
import { WorkspaceError, WorkspaceErrorCode } from "../src/errors.ts";

export type Input = ActionInput<"files.write">;
export type Output = ActionOutput<"files.write">;

export default defineAction<Input, Output>(async (input, ctx) => {
  const workspaceRoot = ctx.config.get<string>("WORKSPACE_ROOT", process.cwd());
  const pathPolicy = new WorkspacePathPolicy(workspaceRoot);

  if (!input.path || typeof input.path !== "string" || !input.path.trim()) {
    throw new WorkspaceError(
      "File path must not be empty",
      WorkspaceErrorCode.INVALID_ARGUMENT,
      400
    );
  }

  const createDirs = input.createDirs !== false;
  const overwrite = input.overwrite !== false;

  const resolved = pathPolicy.resolveAndValidate(input.path, {
    allowNonExistent: true,
  });

  if (!resolved.relativePath) {
    throw new WorkspaceError(
      "Path cannot refer to workspace root",
      WorkspaceErrorCode.PATH_IS_DIRECTORY,
      400
    );
  }

  const fileExists = fs.existsSync(resolved.absolutePath);

  if (fileExists) {
    const stat = fs.statSync(resolved.absolutePath);
    if (stat.isDirectory()) {
      throw new WorkspaceError(
        `Target path is a directory: ${resolved.relativePath}`,
        WorkspaceErrorCode.PATH_IS_DIRECTORY,
        400
      );
    }
    if (!overwrite) {
      throw new WorkspaceError(
        `File already exists and overwrite is false: ${resolved.relativePath}`,
        WorkspaceErrorCode.FILE_ALREADY_EXISTS,
        409
      );
    }
  }

  const parentDir = path.dirname(resolved.absolutePath);
  if (!fs.existsSync(parentDir)) {
    if (!createDirs) {
      throw new WorkspaceError(
        `Parent directory does not exist: ${pathPolicy.toRelativePath(parentDir)}`,
        WorkspaceErrorCode.DIRECTORY_NOT_FOUND,
        404
      );
    }
    fs.mkdirSync(parentDir, { recursive: true });
  } else {
    const parentStat = fs.statSync(parentDir);
    if (!parentStat.isDirectory()) {
      throw new WorkspaceError(
        `Parent path is not a directory: ${pathPolicy.toRelativePath(parentDir)}`,
        WorkspaceErrorCode.PARENT_NOT_DIRECTORY,
        400
      );
    }
  }

  if (ctx.signal?.aborted) {
    throw new Error("Write operation aborted by caller");
  }

  const content = input.content ?? "";
  fs.writeFileSync(resolved.absolutePath, content, "utf8");
  const bytesWritten = Buffer.byteLength(content, "utf8");

  return {
    path: resolved.relativePath,
    bytesWritten,
    created: !fileExists,
  };
});
