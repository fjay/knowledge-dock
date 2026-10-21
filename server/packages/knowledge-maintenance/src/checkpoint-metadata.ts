import path from "node:path";
import type { ActionContext } from "@actiondock/sdk";
import { MaintenanceError } from "./errors.ts";

export interface KnowledgeChange {
  path: string;
  summary: string;
}

interface CheckpointMetadata {
  checkpointSummary: string | null;
  knowledgeChanges?: KnowledgeChange[];
}

function invalidChanges(field: string, reason: string): never {
  throw new MaintenanceError(
    `Invalid ${field}: ${reason}`,
    "INVALID_KNOWLEDGE_CHANGES",
    400
  );
}

/** 仅做词法校验，不要求文件存在，兼容本次已删除的知识文档。 */
export function validateKnowledgeChanges(value: unknown): KnowledgeChange[] {
  if (!Array.isArray(value)) {
    invalidChanges("knowledgeChanges", "expected an array");
  }

  const changes: KnowledgeChange[] = [];
  for (const [index, item] of value.entries()) {
    const field = `knowledgeChanges[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      invalidChanges(field, "expected an object with path and summary");
    }
    if (Object.keys(item).some((key) => key !== "path" && key !== "summary")) {
      invalidChanges(field, "only path and summary are allowed");
    }
    if (typeof item.path !== "string" || !item.path.trim()) {
      invalidChanges(`${field}.path`, "expected a non-empty string");
    }
    const documentPath: string = item.path;
    if (
      documentPath !== documentPath.trim() ||
      path.posix.isAbsolute(documentPath) ||
      path.win32.isAbsolute(documentPath) ||
      /[\\:\u0000-\u001f\u007f-\u009f]/u.test(documentPath) ||
      documentPath.split("/").some((segment) =>
        !segment || segment === "." || segment === ".." || /[ .]$/u.test(segment)
      )
    ) {
      invalidChanges(`${field}.path`, "expected a safe repository-relative path without traversal, backslashes or control characters");
    }
    if (typeof item.summary !== "string" || !item.summary.trim()) {
      invalidChanges(`${field}.summary`, "expected a non-empty string");
    }
    changes.push({ path: documentPath, summary: item.summary });
  }
  return changes;
}

/** 异常清单整体省略并告警，不能过滤坏条目后伪装成已核验的完整清单。 */
export function readCheckpointMetadata(
  savedState: unknown,
  log: Pick<ActionContext["log"], "warn">,
  repo: string
): CheckpointMetadata {
  const metadata: CheckpointMetadata = { checkpointSummary: null };
  if (savedState === undefined || savedState === null) return metadata;
  if (typeof savedState !== "object" || Array.isArray(savedState)) {
    log.warn("Invalid checkpoint metadata; handoff metadata omitted", { repo });
    return metadata;
  }

  if ("summary" in savedState && savedState.summary !== null && savedState.summary !== undefined) {
    if (typeof savedState.summary === "string") {
      metadata.checkpointSummary = savedState.summary;
    } else {
      log.warn("Invalid checkpoint summary; checkpointSummary is null", { repo });
    }
  }
  if ("knowledgeChanges" in savedState && savedState.knowledgeChanges !== null && savedState.knowledgeChanges !== undefined) {
    try {
      metadata.knowledgeChanges = validateKnowledgeChanges(savedState.knowledgeChanges);
    } catch (error) {
      if (!(error instanceof MaintenanceError)) throw error;
      log.warn("Invalid checkpoint knowledgeChanges; complete document change list unavailable", {
        repo,
        error: error.message,
      });
    }
  }
  return metadata;
}
