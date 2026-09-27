import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defineAction } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { KnowledgeInboxError } from "../src/errors.ts";
import { serializeMarkdownWithFrontmatter, extractCandidateYear, VALID_RESOLUTIONS } from "../src/frontmatter.ts";
import {
  getInboxRoot,
  ensureDirectory,
  findPendingCandidate,
} from "../src/storage.ts";

export type Input = ActionInput<"knowledge.archive">;
export type Output = ActionOutput<"knowledge.archive">;

export default defineAction<Input, Output>(async (input, ctx) => {
  const rawId = input.id ? String(input.id).trim() : "";
  const resolution = (input.resolution ?? "accepted") as Output["resolution"];
  const note = input.note ? String(input.note).trim() : undefined;

  ctx.log.info("Starting knowledge.archive", {
    id: rawId,
    resolution,
    hasNote: Boolean(note),
  });

  // 1. Validate inputs
  if (!rawId) {
    throw new KnowledgeInboxError(
      "Document identifier (id or filename) is required.",
      "ID_REQUIRED",
      400
    );
  }

  if (!VALID_RESOLUTIONS.has(resolution)) {
    throw new KnowledgeInboxError(
      `Invalid resolution: '${input.resolution}'. Allowed values: accepted, duplicate, rejected, insufficient_evidence.`,
      "INVALID_RESOLUTION",
      400
    );
  }

  // 2. Locate candidate file in pending directory
  const inboxRoot = getInboxRoot(ctx);
  const pendingDir = path.join(inboxRoot, "pending");

  const match = await findPendingCandidate(pendingDir, rawId);
  if (!match) {
    throw new KnowledgeInboxError(
      `Pending candidate document not found for identifier: '${rawId}'.`,
      "DOCUMENT_NOT_FOUND",
      404
    );
  }

  const { filePath: sourcePath, filename: matchedFilename, frontmatter } = match;
  const docId =
    (frontmatter.data && typeof frontmatter.data.id === "string" && frontmatter.data.id.trim())
      ? frontmatter.data.id.trim()
      : rawId;

  // 3. Extract year and prepare target destination directory (processed/<year>/<resolution>/)
  const year = extractCandidateYear(frontmatter.data, docId);
  const targetDir = path.join(inboxRoot, "processed", year, resolution);
  await ensureDirectory(targetDir);
  const targetFilePath = path.join(targetDir, matchedFilename);

  // 4. Update frontmatter metadata
  const updatedData: Record<string, any> = { ...frontmatter.data };
  updatedData.status = "processed";
  updatedData.resolution = resolution;
  updatedData.archived_at = new Date().toISOString();
  if (note) {
    updatedData.archive_note = note;
  }

  const updatedContent = serializeMarkdownWithFrontmatter(
    updatedData,
    frontmatter.body
  );

  // 5. Atomically move file to processed directory
  const tempPath = path.join(
    targetDir,
    `.${matchedFilename}.tmp-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`
  );

  try {
    await fs.promises.writeFile(tempPath, updatedContent, "utf-8");
    await fs.promises.rename(tempPath, targetFilePath);
    try {
      await fs.promises.unlink(sourcePath);
    } catch (unlinkErr: any) {
      // 并发归档同一文档时前一个请求已删除源文件，视为归档成功
      if (unlinkErr.code !== "ENOENT") {
        throw unlinkErr;
      }
    }
  } catch (err: any) {
    // Clean up temporary file if write or rename failed
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // ignore cleanup errors
    }
    ctx.log.error("Failed to move candidate to archive location", {
      error: err.message,
      sourcePath,
      targetFilePath,
    });
    throw new KnowledgeInboxError(
      `Failed to archive document: ${err.message}`,
      "ARCHIVE_FAILED",
      500
    );
  }

  ctx.log.info("Successfully archived knowledge document", {
    id: docId,
    resolution,
    year,
    fromPath: sourcePath,
    toPath: targetFilePath,
  });

  return {
    id: docId,
    fromPath: sourcePath,
    toPath: targetFilePath,
    resolution,
    status: "archived",
    year,
  };
});
