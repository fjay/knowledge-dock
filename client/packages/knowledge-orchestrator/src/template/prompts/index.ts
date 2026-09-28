import { buildCodeRepoPrompt } from "./code-repo.ts";
import { buildSystemKnowledgePrompt } from "./system-knowledge.ts";
import { buildInboxCandidatePrompt } from "./inbox-candidate.ts";

export { buildCodeRepoPrompt } from "./code-repo.ts";
export { buildSystemKnowledgePrompt } from "./system-knowledge.ts";
export { buildInboxCandidatePrompt } from "./inbox-candidate.ts";

/**
 * 构造统一维护指导语模版，根据仓库类型自动分流
 */
export function buildPrompt(data: any): string {
  if (data?.repoType === "system_knowledge") {
    return buildSystemKnowledgePrompt(data);
  }
  if (data?.repoType === "inbox" || data?.candidateId) {
    return buildInboxCandidatePrompt(data);
  }
  return buildCodeRepoPrompt(data);
}
