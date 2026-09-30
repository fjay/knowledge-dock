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
    `## 主智能体统筹与专业子代理协同架构`,
    ``,
    `- 主智能体角色定位：作为待审池总控中枢，负责统筹初筛与最终验收，通过专业子代理协同完成闭环，全流程全自动自闭环，严禁在终端向用户提问或等待确认。`,
    `- 专业子代理协同分工：`,
    `  - 版本初筛与消歧子代理：调阅待审池全量候选（ad run knowledge.list --profile skm -- status="pending"），横向梳理同作者、同仓库与同主题的版本演进链路（v1/v2/v3）；识别替代与废弃声明，将已被终版吸收或证伪的历史版本直接调用 knowledge.archive 批量归档（resolution 标为 duplicate 或 rejected，并在 note 注明“非终版，已被终版候选 <id> 吸收替代”）；`,
    `  - 核心经验核验与合入子代理：聚焦初筛后的有效终版候选，直读候选并深入代码仓核验源码事实，补全排查上下文并合入规范文档，运行 links.verify 达成零断链并执行 maintenance.publish，最终调用 knowledge.archive 归档为 accepted。`,
    ``,
    `## 审查核验与决议准则`,
    ``,
    `- 事实核验与直读：调用 ad run workspace/files.read --profile skm -- path="${candidatePath}" 调阅候选内容；结合真实代码仓核验符号与逻辑，严禁未查代码轻率驳回。`,
    `- 四路决议判定准则（杜绝偷懒逃避沉淀）：`,
    `  - 采纳并沉淀（accepted）：经验具通用排障或架构指导价值，融入对应代码仓或系统知识仓 runbook 及对应分类文档；`,
    `  - 重复条目（duplicate）：已有正式知识库文档完全覆盖该场景，或已被终版候选吸收，归档说明中必须注明被覆盖文档路径或终版候选标识；`,
    `  - 证据不足（insufficient_evidence）：查证代码后确凿证明缺失关键事实且无法补全；`,
    `  - 驳回废弃（rejected）：方案错误、时效过旧已淘汰，或结论被后续版本证伪，归档说明中必须给出代码事实反证或终版替代说明。`,
    `- 采纳沉淀质量门禁：修改严格收敛在 docs/knowledge/ 目录或系统对应领域，编辑后必须执行 ad run workspace/links.verify --profile skm -- path="<目标工作区绝对路径>" 达成零断链，并执行 ad run maintenance/maintenance.publish --profile skm -- path="<目标工作区绝对路径>" message="docs: incorporate inbox candidate ${id}" 提交发布。`,
    `- 最终归档交付（绝对交付标志）：审查结束后必须显式调用 ad run knowledge.archive --profile skm -- id="${id}" resolution="<accepted|duplicate|insufficient_evidence|rejected>" note="<归档审理说明>" 移出待审池。`,
  ];

  return lines.join("\n");
}
