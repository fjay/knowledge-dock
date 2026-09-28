/**
 * 构造针对待审池单个候选文档的标准评审与沉淀指导语
 */
export function buildInboxCandidatePrompt(candidate: any = {}): string {
  const id = candidate.id || candidate.candidateId || "";
  const filename = candidate.filename || candidate.candidateFilename || "";
  const title = candidate.title || candidate.candidateTitle || filename || id;
  const candidatePath =
    candidate.path ||
    candidate.candidatePath ||
    (filename ? `/srv/knowledge-inbox/pending/${filename}` : "/srv/knowledge-inbox/pending");
  const domain = candidate.domain || candidate.candidateDomain || "未分类";
  const repos =
    Array.isArray(candidate.repos) && candidate.repos.length > 0
      ? candidate.repos.join(", ")
      : "全局/未关联指定代码仓";
  const tags =
    Array.isArray(candidate.tags) && candidate.tags.length > 0
      ? candidate.tags.join(", ")
      : "无标签";
  const createdAt = candidate.createdAt || "未知";

  const lines = [
    `# 排障经验待审池候选评审指导`,
    ``,
    `请针对待审候选文档「${title}」（标识：${id}）执行审查提炼与归档留痕闭环。`,
    ``,
    `## 任务背景与元数据`,
    ``,
    `- 候选标识：${id}`,
    `- 候选标题：${title}`,
    `- 候选文件名：${filename}`,
    `- 文件绝对路径：${candidatePath}`,
    `- 业务领域：${domain}`,
    `- 关联仓库：${repos}`,
    `- 标签：${tags}`,
    `- 收集时间：${createdAt}`,
    ``,
    `## 技能规范与参考`,
    ``,
    `请挂载并严格遵循 skills/knowledge-maintenance-orchestrator/SKILL.md 与 skills/project-knowledge-maintainer 技能规范。`,
    ``,
    `## 审查提炼与核验闭环流程`,
    ``,
    `- 直读候选内容：调阅待审文件完整内容并核验技术细节与客观事实：`,
    `  - ad run workspace/files.read --profile skm -- path="${candidatePath}" startLine:=1 maxLines:=2000`,
    `- 四路决议判定准则：`,
    `  - 采纳并沉淀（accepted）：经验具有通用排障或架构指导价值。需将有效知识融入对应代码仓或系统知识仓的 runbook 或对应分类文档中；`,
    `  - 重复条目（duplicate）：已有正式知识库文档完全覆盖该场景，无需重复沉淀；`,
    `  - 证据不足（insufficient_evidence）：缺乏关键诊断日志、复现步骤或核心事实，无法指导排障；`,
    `  - 驳回废弃（rejected）：方案错误、时效过旧已淘汰或不符合技术规范。`,
    `- 采纳沉淀时的质量门禁：`,
    `  - 涉及知识库修改时，严格收敛在 docs/knowledge/ 目录或系统知识库对应领域目录；`,
    `  - 完成编辑后必须执行断链校验：ad run workspace/links.verify --profile skm -- path="<目标工作区绝对路径>"；`,
    `  - 若有断链必须就地修复至零断链；`,
    `  - 提交并发布：ad run maintenance/maintenance.publish --profile skm -- path="<目标工作区绝对路径>" message="docs: incorporate inbox candidate ${id}"；`,
    `- 最终归档交付（绝对交付标志）：`,
    `  - 审查结束后必须显式调用归档动作，将候选文档原子移入处理归档目录：`,
    `  - 归档动作调用：ad run knowledge.archive --profile skm -- id="${id}" resolution="<accepted|duplicate|insufficient_evidence|rejected>" note="<归档审理说明>"`,
    `  - 归档成功将自动移出 pending 待审目录，完成单篇候选闭环。`,
  ];

  return lines.join("\n");
}
