import path from "node:path";
import { buildPrompt } from "./prompts/index.ts";
import { buildInboxCandidatePrompt } from "./prompts/inbox-candidate.ts";

/**
 * 从待审候选条目抽取全量模版占位符
 */
export function buildInboxPlaceholders(candidate: any = {}, extraContext: any = {}): Record<string, any> {
  const id = candidate.id || candidate.candidateId || "";
  const filename = candidate.filename || candidate.candidateFilename || "";
  const title = candidate.title || candidate.candidateTitle || filename || id;
  const candidatePath =
    candidate.path ||
    candidate.candidatePath ||
    (filename ? `/srv/knowledge-inbox/pending/${filename}` : "/srv/knowledge-inbox/pending");
  const domain = candidate.domain || candidate.candidateDomain || "未分类";
  const repos = Array.isArray(candidate.repos) ? candidate.repos : [];
  const prompt = buildInboxCandidatePrompt(candidate);

  return {
    candidateId: id,
    candidateTitle: title,
    candidateFilename: filename,
    candidatePath,
    candidateDomain: domain,
    id,
    title,
    filename,
    path: candidatePath,
    repo: repos[0] || "knowledge-inbox",
    repos: repos.join(", "),
    prompt,
    ...extraContext,
  };
}

/**
 * 从扫描条目抽取全量模版占位符
 */
export function buildPlaceholders(item: any = {}, extraContext: any = {}): Record<string, any> {
  const repo = item.repo || (item.path ? path.basename(item.path) : "");
  const repoPath = item.path || (repo ? `/srv/workspace/${repo}` : "/srv/workspace");
  const branch = item.branch || "master";
  const from = item.from || "initial";
  const to = item.to || "";
  const commitCount = item.commitCount ?? (Array.isArray(item.commits) ? item.commits.length : 0);

  const rawType = item.repoType || "";
  const repoType =
    rawType === "system_knowledge" || rawType === "code"
      ? rawType
      : (repo.toLowerCase().includes("system-knowledge") ||
         repo.toLowerCase().includes("knowledge-system") ||
         repoPath.toLowerCase().includes("system-knowledge") ||
         repoPath.toLowerCase().includes("knowledge-system")
          ? "system_knowledge"
          : "code");

  let changedFilesCount = 0;
  if (item.changedFilesSummary) {
    changedFilesCount = item.changedFilesSummary.filesChanged ?? (item.changedFilesSummary.files?.length ?? 0);
  }

  let diffSummary = "";
  if (item.changedFilesSummary?.summaryText) {
    diffSummary = item.changedFilesSummary.summaryText;
  } else if (changedFilesCount > 0) {
    diffSummary = `${changedFilesCount} files changed`;
  } else {
    diffSummary = "0 files changed";
  }

  let commitsSummary = "";
  if (Array.isArray(item.commits) && item.commits.length > 0) {
    commitsSummary = item.commits
      .map((c: any) => `${c.shortHash || c.hash?.slice(0, 7) || ""} ${c.message || ""}`.trim())
      .join("\n");
  } else if (item.initialInventoryRequired) {
    commitsSummary = "冷启动建库：无历史检查点基线";
  } else {
    commitsSummary = "无新增提交";
  }

  const codePhaseSummary = extraContext.codePhaseSummary || "";

  const prompt = buildPrompt({
    repo,
    path: repoPath,
    branch,
    repoType,
    from,
    to,
    commitCount,
    changedFilesCount,
    diffSummary,
    commitsSummary,
    codePhaseSummary,
  });

  return {
    repo,
    path: repoPath,
    branch,
    repoType,
    from,
    to,
    commitCount,
    changedFilesCount,
    diffSummary,
    commitsSummary,
    codePhaseSummary,
    prompt,
    candidateId: "",
    candidateTitle: "",
    candidateFilename: "",
  };
}
