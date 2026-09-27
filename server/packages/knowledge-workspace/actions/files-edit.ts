import fs from "node:fs";
import { defineAction } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { WorkspacePathPolicy } from "../src/path-policy.ts";
import { validateUtf8File, getLineOffsets } from "../src/file-policy.ts";
import { WorkspaceError, WorkspaceErrorCode } from "../src/errors.ts";

export type Input = ActionInput<"files.edit">;
export type Output = ActionOutput<"files.edit">;

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

  if (typeof input.targetContent !== "string" || input.targetContent === "") {
    throw new WorkspaceError(
      "targetContent must be a non-empty string",
      WorkspaceErrorCode.INVALID_ARGUMENT,
      400
    );
  }

  if (typeof input.replacementContent !== "string") {
    throw new WorkspaceError(
      "replacementContent must be a string",
      WorkspaceErrorCode.INVALID_ARGUMENT,
      400
    );
  }

  const allowMultiple = Boolean(input.allowMultiple);

  const resolved = pathPolicy.resolveAndValidate(input.path);
  if (!resolved.stat || !resolved.stat.isFile()) {
    throw new WorkspaceError(
      `Path is not a regular file: ${input.path}`,
      WorkspaceErrorCode.NOT_A_FILE,
      400
    );
  }

  validateUtf8File(resolved.absolutePath, resolved.stat.size);

  let fileContent: string;
  try {
    const rawBuffer = fs.readFileSync(resolved.absolutePath);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    fileContent = decoder.decode(rawBuffer);
  } catch {
    throw new WorkspaceError(
      "Non-UTF-8 text encoding is not supported",
      WorkspaceErrorCode.UNSUPPORTED_TEXT_ENCODING,
      415
    );
  }

  const lines = getLineOffsets(fileContent);
  const hasStartLine = input.startLine !== undefined;
  const hasEndLine = input.endLine !== undefined;

  if (hasStartLine && input.startLine! < 1) {
    throw new WorkspaceError(
      `startLine must be greater than or equal to 1: ${input.startLine}`,
      WorkspaceErrorCode.INVALID_LINE_RANGE,
      400
    );
  }

  if (hasEndLine && input.endLine! < 1) {
    throw new WorkspaceError(
      `endLine must be greater than or equal to 1: ${input.endLine}`,
      WorkspaceErrorCode.INVALID_LINE_RANGE,
      400
    );
  }

  if (hasStartLine && hasEndLine && input.startLine! > input.endLine!) {
    throw new WorkspaceError(
      `startLine (${input.startLine}) must be less than or equal to endLine (${input.endLine})`,
      WorkspaceErrorCode.INVALID_LINE_RANGE,
      400
    );
  }

  if (hasStartLine && input.startLine! > lines.length) {
    throw new WorkspaceError(
      `startLine (${input.startLine}) is out of bounds (file has ${lines.length} lines)`,
      WorkspaceErrorCode.INVALID_LINE_RANGE,
      400
    );
  }

  if (hasEndLine && input.endLine! > lines.length) {
    throw new WorkspaceError(
      `endLine (${input.endLine}) is out of bounds (file has ${lines.length} lines)`,
      WorkspaceErrorCode.INVALID_LINE_RANGE,
      400
    );
  }

  let rangeStart = 0;
  let rangeEnd = fileContent.length;

  if (hasStartLine || hasEndLine) {
    const startLineIdx = hasStartLine ? input.startLine! - 1 : 0;
    const endLineIdx = hasEndLine ? input.endLine! - 1 : lines.length - 1;

    rangeStart = lines[startLineIdx]?.start ?? 0;
    rangeEnd = lines[endLineIdx]?.end ?? fileContent.length;
  }

  const searchScope = fileContent.slice(rangeStart, rangeEnd);

  let count = 0;
  let pos = 0;
  while (pos <= searchScope.length) {
    const idx = searchScope.indexOf(input.targetContent, pos);
    if (idx === -1) break;
    count++;
    pos = idx + input.targetContent.length;
  }

  if (count === 0) {
    throw new WorkspaceError(
      `Target content not found in ${resolved.relativePath}`,
      WorkspaceErrorCode.TARGET_NOT_FOUND,
      404
    );
  }

  if (count > 1 && !allowMultiple) {
    throw new WorkspaceError(
      `Found ${count} occurrences of target content in ${resolved.relativePath}, but allowMultiple is false`,
      WorkspaceErrorCode.AMBIGUOUS_REPLACEMENT,
      409
    );
  }

  const replacedScope = allowMultiple
    ? searchScope.replaceAll(input.targetContent, () => input.replacementContent)
    : searchScope.replace(input.targetContent, () => input.replacementContent);

  const newContent =
    fileContent.slice(0, rangeStart) +
    replacedScope +
    fileContent.slice(rangeEnd);

  if (ctx.signal?.aborted) {
    throw new Error("Edit operation aborted by caller");
  }

  fs.writeFileSync(resolved.absolutePath, newContent, "utf8");
  const bytesWritten = Buffer.byteLength(newContent, "utf8");

  return {
    path: resolved.relativePath,
    replacementsCount: count,
    bytesWritten,
  };
});
