/**
 * 构造无人值守单代码仓合并冲突自主消解指导语模版
 */
export function buildConflictResolutionPrompt(data: any): string {
  const repo = data.repo || "";
  const repoPath = data.path || (repo ? `/srv/workspace/${repo}` : "/srv/workspace");
  const branch = data.branch || "release";
  const knowledgeBranch = data.knowledgeBranch || "docs";
  const to = data.to || "";
  const conflictFilesList = data.conflictFilesList || "  - (未检测到具体冲突文件)";

  const lines = [
    `# 知识维护单仓冲突消解任务指导`,
    ``,
    `请针对目标仓库 ${repo} 执行分支合并冲突自主消解与知识维护闭环。`,
    ``,
    `## 任务背景与基线`,
    ``,
    `- 目标仓库：${repo}`,
    `- 工作区绝对路径：${repoPath}`,
    `- 主干分支：${branch}`,
    `- 知识分支：${knowledgeBranch}`,
    `- 目标检查点：${to}`,
    `- 冲突文件清单：`,
    conflictFilesList,
    ``,
    `## 全自动无人值守消解铁律`,
    ``,
    `- 全自动自闭环铁律：本任务为无人值守全自动流水线调度，严禁在终端向用户提问、索求确认或等待人工决策，必须自主分析冲突块并就地闭环。`,
    `- 冲突标记清除铁律：必须逐一审阅所有冲突文件，消除所有冲突标记（包含小于号、等号与大于号的分隔标记），严禁遗留任何未决标记。`,
    `- 语义调和准则：对比主干分支与知识分支的变动内容，以最新主干事实为基准，保留知识分支中的既有专业沉淀，完成双向调和。`,
    ``,
    `## 特权受控工具自省契约`,
    ``,
    `- 动作调用契约与入参规范一律通过 ActionDock 特权环境（--profile skm）原生自省获取：`,
    `  - 读取冲突内容：通过 workspace/files.read 读取包含冲突标记的文件内容；`,
    `  - 就地消解覆盖：通过 workspace/files.edit 或 workspace/files.write 完成冲突标记消除与内容合并；`,
    `  - 状态审查验证：通过 workspace/bash.exec 运行 git status 确认冲突文件已全部消解。`,
    ``,
    `## 断链自检、工作区审查与就地修复门禁（铁律）`,
    ``,
    `- 冲突文件消解后必须执行断链校验：`,
    `  - ad run workspace/links.verify --profile skm -- path="${repoPath}"`,
    `- 若存在断链（brokenCount > 0）必须使用 files.edit 立即就地修复至零断链（brokenCount === 0）。`,
    `- 提交前必须执行工作区状态审查，确认所有冲突文件均已暂存或已解决：`,
    `  - ad run workspace/bash.exec --profile skm -- command="git status" cwd="${repoPath}"`,
    ``,
    `## 最终交付与推进检查点水位（绝对交付标志）`,
    ``,
    `- 冲突消解与断链修复完成后，调用发布动作完成合并提交与远端推送：`,
    `  - ad run maintenance/maintenance.publish --profile skm -- path="${repoPath}" message="docs: resolve merge conflict and update knowledge for ${repo}"`,
    `- 发布成功后必须显式推进检查点水位至最新提交（绝对交付标志）：`,
    `  - ad run maintenance/maintenance.complete --profile skm -- path="${repoPath}" commit="${to}" actionTaken="conflict_resolved" summary="自动消解分支合并冲突并同步知识文档"`,
  ];

  return lines.join("\n");
}
