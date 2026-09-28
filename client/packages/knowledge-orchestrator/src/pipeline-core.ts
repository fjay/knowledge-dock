import fs from "node:fs";
import path from "node:path";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface PipelineOptions {
  profile?: string;
  dispatchCmd?: string;
  timeout?: number;
  interval?: number;
  dryRun?: boolean;
  only?: string | null;
  skipSystemKnowledge?: boolean;
  skipInbox?: boolean;
  reportFile?: string | null;
  logFile?: string | null;
  help?: boolean;
}

export interface DryRunItem {
  repo: string;
  path: string;
  repoType: string;
  renderedCommand: string;
  placeholders: Record<string, any>;
}

export interface DryRunResult {
  dryRun: true;
  total: number;
  skipped: number;
  pending: number;
  dryRunOutput: DryRunItem[];
  inboxTotal?: number;
  inboxCompleted?: number;
  inboxFailed?: number;
  inboxSkipped?: boolean;
  inboxResults?: InboxCandidateResult[];
}

export interface RepoResult {
  repo: string;
  path: string;
  repoType: "code" | "system_knowledge";
  status: "completed" | "skipped" | "failed";
  targetCommit?: string;
  durationMs: number;
  message: string;
}

export interface InboxCandidate {
  id: string;
  filename: string;
  path: string;
  status: string;
  year?: string;
  title?: string;
  domain?: string;
  tags?: string[];
  repos?: string[];
  createdAt?: string;
}

export interface InboxCandidateResult {
  id: string;
  filename: string;
  title: string;
  durationMs: number;
  status: "completed" | "failed";
  error?: string | null;
}

export interface InboxPhaseSummary {
  inboxTotal: number;
  inboxCompleted: number;
  inboxFailed: number;
  inboxSkipped: boolean;
  inboxResults: InboxCandidateResult[];
}

export interface PipelineSummary {
  profile: string;
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  totalElapsedMs: number;
  results: RepoResult[];
  markdownReport: string;
  reportSaved: boolean;
  logFile?: string | null;
  dryRun?: false;
  success?: boolean;
  inboxTotal?: number;
  inboxCompleted?: number;
  inboxFailed?: number;
  inboxSkipped?: boolean;
  inboxResults?: InboxCandidateResult[];
}

export interface PipelineHooks {
  execFn?: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
  dispatchFn?: ((cmd: string, placeholders?: any) => Promise<any>) | null;
  sleepFn?: (ms: number) => Promise<void>;
  onProgress?: ((stats: any) => void) | null;
  logFn?: ((msg: string) => void) | null;
  nowFn?: () => number;
}

/**
 * 命令行参数解析
 */
export function parseArgs(argv: string[] = []): Required<PipelineOptions> {
  const options: Required<PipelineOptions> = {
    profile: "skm",
    dispatchCmd: "",
    timeout: 15,
    interval: 10,
    dryRun: false,
    only: null,
    skipSystemKnowledge: false,
    skipInbox: false,
    reportFile: "maintenance-report.md",
    logFile: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--profile") {
      options.profile = argv[++i] ?? options.profile;
    } else if (arg.startsWith("--profile=")) {
      options.profile = arg.slice("--profile=".length);
    } else if (arg === "--dispatch-cmd") {
      options.dispatchCmd = argv[++i] ?? options.dispatchCmd;
    } else if (arg.startsWith("--dispatch-cmd=")) {
      options.dispatchCmd = arg.slice("--dispatch-cmd=".length);
    } else if (arg === "--timeout") {
      const val = parseFloat(argv[++i]);
      if (!Number.isNaN(val) && val > 0) options.timeout = val;
    } else if (arg.startsWith("--timeout=")) {
      const val = parseFloat(arg.slice("--timeout=".length));
      if (!Number.isNaN(val) && val > 0) options.timeout = val;
    } else if (arg === "--interval") {
      const val = parseFloat(argv[++i]);
      if (!Number.isNaN(val) && val > 0) options.interval = val;
    } else if (arg.startsWith("--interval=")) {
      const val = parseFloat(arg.slice("--interval=".length));
      if (!Number.isNaN(val) && val > 0) options.interval = val;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--only") {
      options.only = argv[++i] ?? options.only;
    } else if (arg.startsWith("--only=")) {
      options.only = arg.slice("--only=".length);
    } else if (arg === "--skip-system-knowledge") {
      options.skipSystemKnowledge = true;
    } else if (arg === "--skip-inbox") {
      options.skipInbox = true;
    } else if (arg.startsWith("--skip-inbox=")) {
      options.skipInbox = arg.slice("--skip-inbox=".length) !== "false";
    } else if (arg === "--report-file") {
      options.reportFile = argv[++i] ?? options.reportFile;
    } else if (arg.startsWith("--report-file=")) {
      options.reportFile = arg.slice("--report-file=".length);
    } else if (arg === "--log-file") {
      options.logFile = argv[++i] ?? options.logFile;
    } else if (arg.startsWith("--log-file=")) {
      options.logFile = arg.slice("--log-file=".length);
    }
  }

  return options;
}

/**
 * 安全引号转义，避免在 Shell 命令双引号字符串中插值时破裂。
 * 除双引号与反斜杠外，同时转义 $ 与反引号，阻断 $() 、 ${} 与 `` 展开注入。
 */
export function escapeQuotes(val: any): string {
  if (val === null || val === undefined) return "";
  return String(val)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}

/**
 * 格式化耗时（毫秒转为分秒格式）
 */
export function formatDuration(ms: number = 0): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 进度条字符串渲染
 */
export function renderProgressBar(current: number = 0, total: number = 0, width: number = 20): string {
  if (total <= 0) return `[${"=".repeat(width)}] 100%`;
  const ratio = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const bar = "=".repeat(Math.max(0, filled - 1)) + (filled > 0 ? ">" : "") + " ".repeat(empty);
  const percent = Math.round(ratio * 100);
  return `[${bar}] ${percent}% (${current}/${total})`;
}

/**
 * 终端实时看板渲染
 */
export function renderDashboard(stats: {
  total: number;
  processed: number;
  skipped: number;
  completed: number;
  failed: number;
  activeRepo?: string;
  activeRepoElapsed?: number;
  totalElapsed: number;
  inboxTotal?: number;
  inboxProcessed?: number;
  inboxCompleted?: number;
  inboxFailed?: number;
  inboxSkipped?: boolean;
  activeCandidate?: string;
  activeCandidateElapsed?: number;
}): string {
  const progressBar = renderProgressBar(stats.processed, stats.total);
  const lines = [
    `流水线进度: ${progressBar}`,
    `总仓数: ${stats.total} | 已跳过: ${stats.skipped} | 已完成: ${stats.completed} | 失败: ${stats.failed}`,
  ];

  if (stats.activeRepo) {
    lines.push(
      `当前活跃仓: ${stats.activeRepo} | 单仓耗时: ${formatDuration(stats.activeRepoElapsed ?? 0)} | 总耗时: ${formatDuration(stats.totalElapsed)}`
    );
  } else {
    lines.push(`总耗时: ${formatDuration(stats.totalElapsed)}`);
  }

  if (stats.inboxTotal !== undefined && stats.inboxTotal > 0) {
    const inboxBar = renderProgressBar(stats.inboxProcessed ?? 0, stats.inboxTotal);
    lines.push(`待审池进度: ${inboxBar}`);
    lines.push(
      `待审候选总数: ${stats.inboxTotal} | 已归档: ${stats.inboxCompleted ?? 0} | 失败: ${stats.inboxFailed ?? 0}`
    );
    if (stats.activeCandidate) {
      lines.push(
        `当前待审候选: ${stats.activeCandidate} | 单篇耗时: ${formatDuration(stats.activeCandidateElapsed ?? 0)}`
      );
    }
  } else if (stats.inboxSkipped) {
    lines.push(`待审池阶段: 已跳过`);
  }

  return lines.join("\n");
}

/**
 * 构造开箱即用的专业单代码仓维护指导语模版
 */
export function buildCodeRepoPrompt(data: any): string {
  const repo = data.repo || "";
  const repoPath = data.path || (repo ? `/srv/workspace/${repo}` : "/srv/workspace");
  const branch = data.branch || "master";
  const from = data.from || "initial";
  const to = data.to || "";
  const commitCount = data.commitCount ?? 0;
  const changedFilesCount = data.changedFilesCount ?? 0;
  const commitsSummary = data.commitsSummary || "无新增提交";
  const diffSummary = data.diffSummary || "无文件变动";

  const lines = [
    `# 知识维护单仓任务指导`,
    ``,
    `请针对目标仓库 ${repo} 执行单仓全生命周期知识维护与核验闭环。`,
    ``,
    `## 任务背景与基线`,
    ``,
    `- 目标仓库：${repo}`,
    `- 工作区绝对路径：${repoPath}`,
    `- 目标分支：${branch}`,
    `- 前置检查点：${from}`,
    `- 目标检查点：${to}`,
    `- 待核验提交统计：新增提交共 ${commitCount} 个，涉及 ${changedFilesCount} 个文件变动。`,
    ``,
    `### 提交清单摘要`,
    `\`\`\``,
    commitsSummary,
    `\`\`\``,
    ``,
    `### 变动文件统计`,
    `\`\`\``,
    diffSummary,
    `\`\`\``,
    ``,
    `## 技能规范与参考`,
    ``,
    `请挂载并严格遵循 skills/knowledge-maintenance-orchestrator/SKILL.md 与 skills/project-knowledge-maintainer 技能规范。`,
    ``,
    `## 工作区拓扑与绝对路径清单`,
    ``,
    `- 目标仓库：${repoPath}`,
    `- 兄弟代码仓：/srv/workspace/<sibling-repo>`,
    `- 系统知识仓：/srv/workspace/system-knowledge`,
    `- 动作参数统一使用绝对路径。`,
    ``,
    `## 六大分类落盘规范与命名公式`,
    ``,
    `- 知识文档存储目录：${repoPath}/docs/knowledge/<category>/`,
    `- 文件命名公式：<category>-<topic>.md（小写英文与连字符）`,
    `- 根目录导航文件：${repoPath}/docs/knowledge/ 根目录下必须具备 index.md 与 overview.md。`,
    `- 六大分类专项关注与红线约束：`,
    `  - flow 类别：业务端到端主流程、关键分支、关联键流转与失败传播；`,
    `  - interface 类别：对外 HTTP/RPC 接口、MQ 消息事件与调度任务的契约定义、入出参及失败返回；`,
    `  - rule 类别：跨流程公共规则、校验约束、多商户隔离策略与计算公式；`,
    `  - module 类别：核心模块划分、分层职责与内部调用拓扑；`,
    `  - data 类别（红线约束）：数据库事实源在 /srv/workspace/system-knowledge。优先查阅系统知识仓的 db-map.md 与 ddl/data-ddl-{schema}.md；本仓仅建 data/data-databases.md 轻量引用索引，注明所涉表域与数据源，无则标缺口。严禁在代码仓自身文档中复制粘贴表结构或建表脚本；`,
    `  - runbook 类别：排障手册、高频错误码、运维配置与故障自愈流程；`,
    ``,
    `## 更新门槛与失效四问判定`,
    ``,
    `- 失效四问判定（与技能规范定义一致）：`,
    `  - 行为：文档记载的流程、分支、状态、顺序、失败传播是否变化？`,
    `  - 契约：文档记载的接口出入参、事件、队列、配置键语义是否变化？`,
    `  - 定位：文档给出的文件、类、方法是否改名或移动？（行号漂移不算）`,
    `  - 缺失：是否新增了该文档主题内读者需要的事实（新入口、新分支、新失败路径、新公共规则）？`,
    `- 若四问均为“否”（仅为代码重构或优化，业务未变），严禁改动文档，直接判定为无需更新（no_change_needed）。`,
    ``,
    `## 特权受控工具速查与自省指令`,
    ``,
    `- 依托 ActionDock 特权环境（--profile skm），支持 ad info / ad list / ad describe 远端自省：`,
    `  - ad info --profile skm：查看远端挂载的所有工具包、动作与规程概览；`,
    `  - ad list --profile skm：列出远端所有可用动作清单及其功能描述；`,
    `  - ad describe <action> --profile skm：查询具体动作的完整描述、模式定义与传参示例。`,
    `- 常用动作绝对路径调用示例：`,
    `  - 全文检索：ad run workspace/search.rg --profile skm -- pattern="<keyword>" paths.0="${repoPath}"`,
    `  - 分段直读：ad run workspace/files.read --profile skm -- path="${repoPath}/<file>" startLine:=1 maxLines:=2000`,
    `  - 局部编辑：ad run workspace/files.edit --profile skm -- path="${repoPath}/<file>" targetContent="<old>" replacementContent="<new>"（复杂多行推荐使用 --input-file 传递 JSON 文件入参避开转义）；`,
    `  - 安全写入：ad run workspace/files.write --profile skm -- path="${repoPath}/<file>" content="<content>"（大文件或复杂 Markdown 推荐使用 --input-file 传递 JSON 文件入参）；`,
    `  - 目录浏览：ad run workspace/files.list --profile skm -- path="${repoPath}/<dir>" depth:=1`,
    `  - 终端命令与改动回滚：ad run workspace/bash.exec --profile skm -- command="git restore ." cwd="${repoPath}"`,
    ``,
    `## 断链自检、工作区审查与就地修复门禁（铁律）`,
    ``,
    `- 文档新建或修改后必须执行断链校验：`,
    `  - ad run workspace/links.verify --profile skm -- path="${repoPath}"`,
    `- 若有断链（brokenCount > 0）必须使用 files.edit 立即就地修复至零断链（brokenCount === 0）方可汇报。`,
    `- 提交前必须执行工作区状态审查，确认修改完全收敛于文档目录：`,
    `  - 查看状态：ad run workspace/bash.exec --profile skm -- command="git status" cwd="${repoPath}"`,
    `  - 核验差异：ad run workspace/bash.exec --profile skm -- command="git diff" cwd="${repoPath}"`,
    `  - 误改回滚：若误触业务源码立即执行 ad run workspace/bash.exec --profile skm -- command="git restore ." cwd="${repoPath}" 回滚丢弃修改。`,
    ``,
    `## 最终交付与推进检查点水位（绝对交付标志）`,
    ``,
    `- 有文档改动时调用：`,
    `  - ad run maintenance/maintenance.publish --profile skm -- path="${repoPath}" message="docs: update knowledge for ${repo}"`,
    `- 无论文档是否修改，最后必须调用检查点推进动作（绝对交付标志）：`,
    `  - 文档有更新：ad run maintenance/maintenance.complete --profile skm -- path="${repoPath}" commit="${to}" actionTaken="docs_updated" summary="<更新说明>"`,
    `  - 文档无需更新：ad run maintenance/maintenance.complete --profile skm -- path="${repoPath}" commit="${to}" actionTaken="no_change_needed" summary="<代码重构或优化，业务未变，无需更新文档>"`,
  ];

  return lines.join("\n");
}

/**
 * 构造针对系统知识库的全局聚合维护指导语模版
 */
export function buildSystemKnowledgePrompt(data: any): string {
  const repo = data.repo || "system-knowledge";
  const repoPath = data.path || "/srv/workspace/system-knowledge";
  const branch = data.branch || "master";
  const from = data.from || "initial";
  const to = data.to || "";
  const commitCount = data.commitCount ?? 0;
  const changedFilesCount = data.changedFilesCount ?? 0;
  const commitsSummary = data.commitsSummary || "无新增提交";
  const diffSummary = data.diffSummary || "无文件变动";
  const codePhaseSummary = data.codePhaseSummary || "无前序代码仓巡检记录";

  const lines = [
    `# 系统知识库全局聚合维护指导`,
    ``,
    `请针对系统知识库 ${repo}（${repoPath}）执行跨仓领域聚合、新领域发现、端到端流程与全局资产核验闭环。`,
    ``,
    `## 任务背景与基线`,
    ``,
    `- 目标系统仓：${repo}`,
    `- 工作区绝对路径：${repoPath}`,
    `- 目标分支：${branch}`,
    `- 前置检查点：${from}`,
    `- 目标检查点：${to}`,
    `- 待核验提交统计：本仓新增提交共 ${commitCount} 个，涉及 ${changedFilesCount} 个文件变动。`,
    ``,
    `### 前序代码仓巡检摘要`,
    `\`\`\``,
    codePhaseSummary,
    `\`\`\``,
    ``,
    `### 本仓提交清单摘要`,
    `\`\`\``,
    commitsSummary,
    `\`\`\``,
    ``,
    `### 本仓变动文件统计`,
    `\`\`\``,
    diffSummary,
    `\`\`\``,
    ``,
    `## 技能规范与参考`,
    ``,
    `请挂载并严格遵循 skills/knowledge-maintenance-orchestrator/SKILL.md 与 skills/project-knowledge-maintainer 技能规范（重点参考 references/system-knowledge-workflow.md、references/cross-repository.md、references/layout.md 与 references/maintenance.md）。`,
    ``,
    `## 主智能体统筹定位与子代理协同架构`,
    ``,
    `- 主智能体角色定位：作为系统层知识维护总控中枢，主智能体负责统筹决策、方案讨论、子代理调度委派与最终门禁验收，绝不亲自盲目编辑文件。`,
    `- 专业子代理协同分工：`,
    `  - 跨仓契约与领域影响分析子代理：深入工作区兄弟仓提取接口、事件与数据库客观证据，依据三路决策树判定并起草演进方案；`,
    `  - 新领域初始化子代理：负责开辟全新领域目录骨架、一次建齐全部六大分类目录，并同步维护系统根目录索引；`,
    `  - 跨仓主流程子代理：负责横向整合兄弟仓交互行为，起草与更新跨仓端到端主流程；`,
    `  - 接口与数据模型子代理：负责核对跨服务契约交接、全局数据库映射与结构快照。`,
    ``,
    `## 系统知识库目录结构与落盘规范`,
    ``,
    `- 系统层根目录固定资产：`,
    `  - index.md：系统总索引（业务领域清单 + 代码仓归属对照表）；`,
    `  - db-map.md：全局数据库与业务领域映射表（生产与测试库名、业务领域、域名、DDL 快照反查）；`,
    `  - ddl/：生产数据库结构快照（data-ddl-{schema}.md，包含字段语义补丁节）；`,
    `- 业务领域一级子目录落盘规范：`,
    `  - 存储目录：${repoPath}/{业务领域中文名}/（例如 订单履约/、跨境结算/）；`,
    `  - 领域导航文件：每个领域根目录下必须具备 index.md 与 overview.md；`,
    `  - 统一六大类别目录：每个业务领域内部必须具备全部六大分类单数目录（flow/、module/、rule/、interface/、data/、runbook/）；`,
    `  - 文件命名公式：<category>-<topic>.md（小写英文与连字符）；`,
    ``,
    `## 第一阶段：自动化调查与方案对齐（依据推导与决策树）`,
    ``,
    `- 自动化事实证据提取：委派跨仓契约与领域影响分析子代理，横向扫描工作区兄弟仓（/srv/workspace/*）提取证据，杜绝凭空臆测：`,
    `  - 源码接口与路由：检索 Controller、路由定义、RPC 契约与对外暴露服务；`,
    `  - 消息事件：检索 MQ 主题生产者与消费者、消息载荷与队列绑定；`,
    `  - 数据库资产：检索 Flyway 迁移脚本、DDL 变更与持久化实体模型。`,
    `- 三路自动化决策树判定：`,
    `  - 路径一（无需更新）：存量系统知识库有效性与更新判定门禁（失效判定）核验通过，前序代码仓若仅为内部重构或优化，行为层、契约层与数据层均未破坏对外契约与跨仓流程，直接判定为无需更新（no_change_needed）；`,
    `  - 路径二（更新已有领域）：核验跨仓影响是否破坏存量有效性，若触及以下任一维度则更新对应领域文档：`,
    `    - 行为层：跨仓端到端主流程、调用顺序或失败补偿机制是否发生变化；`,
    `    - 契约层：对外 HTTP/RPC 接口、MQ 消息事件或调度任务跨服务交接是否发生变化；`,
    `    - 数据层：是否有数据库表结构变动或全局状态流转调整（核对 db-map.md 与 ddl/ 快照）；`,
    `  - 路径三（开辟新领域）：发现未纳管代码仓或全新业务线契约时，执行业务领域识别与目录初始化三步法：`,
    `    - 调阅根目录 index.md，获取已登记的业务领域清单与代码仓归属对照表；`,
    `    - 扫描工作区（/srv/workspace/*）中所有已纳管代码仓，比对识别是否存在未被任何业务领域纳管的新增代码仓；`,
    `    - 研判业务归属并执行开辟全新领域：在系统知识库根目录下建立新领域中文目录，按统一规范一次建齐全部六大分类目录及基础导航，并在 index.md 与 db-map.md 补齐映射。`,
    `- 人机方案讨论门禁（先议后行铁律）：`,
    `  - 呈递方案草案：凡判定为需要更新已有业务领域或开辟全新业务领域，主智能体必须在终端向用户呈递《业务域演进方案草案》：`,
    `    - 汇报判定依据：列举兄弟仓对外接口、MQ 事件、DDL 变更等具体客观证据；`,
    `    - 汇报受影响清单：拟新建或更新的领域目录、文档列表及对应专业子代理委派计划；`,
    `    - 待确认事项：关键业务术语、跨仓流程主导权归属或数据库映射疑问；`,
    `  - 终端人机讨论：等待用户明确确认或调整输入。获得用户确认授权后方可进入写入阶段；若用户判定无需调整，则直接转入交付阶段。`,
    ``,
    `## 第二阶段：受控写入与专业子代理委派`,
    ``,
    `- 方案获得确认后，主智能体委派专项子代理深入执行写入：`,
    `  - 开辟新领域场景：委派新领域初始化子代理，一次建齐六大分类目录与基础索引；`,
    `  - 跨仓主流程编排场景：委派跨仓主流程子代理，依循统一规范起草 flow/ 文档；`,
    `  - 契约与模型同步场景：委派接口与数据模型子代理，同步 interface/ 契约、db-map.md 与 ddl/ 快照；`,
    `- 主智能体全程把控写入边界，严禁跨领域串碰。`,
    ``,
    `## 第三阶段：零断链验收与推进检查点水位`,
    ``,
    `- 特权受控工具速查与自省指令（--profile skm）：`,
    `  - ad info / ad list / ad describe --profile skm：远端自省可用工具包、动作清单与参数规格；`,
    `  - 全文检索：ad run workspace/search.rg --profile skm -- pattern="<keyword>" paths.0="${repoPath}"`,
    `  - 分段直读：ad run workspace/files.read --profile skm -- path="${repoPath}/<file>" startLine:=1 maxLines:=2000`,
    `  - 局部编辑：ad run workspace/files.edit --profile skm -- path="${repoPath}/<file>" targetContent="<old>" replacementContent="<new>"（复杂多行推荐使用 --input-file 传递 JSON 文件入参避开转义）；`,
    `  - 安全写入：ad run workspace/files.write --profile skm -- path="${repoPath}/<file>" content="<content>"（大文件或复杂 Markdown 推荐使用 --input-file 传递 JSON 文件入参）；`,
    `  - 目录浏览：ad run workspace/files.list --profile skm -- path="${repoPath}" depth:=2`,
    `  - 终端审查：ad run workspace/bash.exec --profile skm -- command="git status" cwd="${repoPath}"`,
    `- 断链自检自愈门禁（铁律）：`,
    `  - 系统知识库修改完成后，必须在系统知识库根目录运行断链校验：`,
    `    - ad run workspace/links.verify --profile skm -- path="${repoPath}"`,
    `  - 若有断链（brokenCount > 0）必须就地修复至零断链（brokenCount === 0）方可放行。`,
    `- 统一发布与推进检查点水位（绝对交付标志）：`,
    `  - 系统知识库修改必须直接提交并推送到 master 分支：`,
    `    - 有文档改动时调用：ad run maintenance/maintenance.publish --profile skm -- path="${repoPath}" repoType="system_knowledge" message="docs(system): sync domain knowledge and cross-service flows"`,
    `  - 无论文档是否修改，最后必须调用检查点推进动作（绝对交付标志）：`,
    `    - 文档有更新：ad run maintenance/maintenance.complete --profile skm -- path="${repoPath}" commit="${to}" actionTaken="docs_updated" summary="<系统知识更新说明>"`,
    `    - 文档无需更新：ad run maintenance/maintenance.complete --profile skm -- path="${repoPath}" commit="${to}" actionTaken="no_change_needed" summary="<系统级跨仓契约与全局领域未失效，无需更新>"`,
  ];

  return lines.join("\n");
}

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

/**
 * 模版插值替换引擎，支持安全引号转义
 */
export function renderTemplate(template: string = "", vars: Record<string, any> = {}, options: { escapeQuotes?: boolean } = {}): string {
  const { escapeQuotes: shouldEscape = true } = options;
  if (!template || typeof template !== "string") return "";

  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const val = vars[key];
      const strVal = val === null || val === undefined ? "" : String(val);
      return shouldEscape ? escapeQuotes(strVal) : strVal;
    }
    return match;
  });
}

/**
 * 判定仓库是否完成检查点闭环
 */
export function isRepoCompleted(statusResult: any, targetCommit?: string | null, options: { dispatchedAt?: number } = {}): boolean {
  if (!statusResult) return false;
  const data = statusResult.data || statusResult;

  // 1. 若指定了任务触发时间戳且远端存在检查点推进时间，判定是否在触发后完成推进
  if (options.dispatchedAt && data.checkpointUpdatedAt) {
    const updatedTime = new Date(data.checkpointUpdatedAt).getTime();
    if (!Number.isNaN(updatedTime) && updatedTime >= options.dispatchedAt) {
      return true;
    }
  }

  // 2. 检查 targetCommit 是否与当前水位对齐
  if (targetCommit) {
    const currentFrom = data.from ? String(data.from).trim() : null;
    const target = String(targetCommit).trim();
    if (currentFrom && (currentFrom === target || currentFrom.startsWith(target) || target.startsWith(currentFrom))) {
      return true;
    }
  }

  // 3. 针对未指定 dispatchedAt 的常规对齐判断
  if (!options.dispatchedAt) {
    if (data.status === "upToDate") {
      return true;
    }

    if (data.hasChanges === false && data.status !== "error") {
      return true;
    }
  }

  return false;
}

/**
 * 默认命令执行函数（基于 child_process.exec）
 */
export async function defaultExec(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
}

/**
 * 侦听远端检查点与变更状态
 */
export async function queryRemoteList(profile: string = "skm", repoPath: string | null = null, execFn: (cmd: string) => Promise<{ stdout: string; stderr: string }> = defaultExec): Promise<any> {
  let cmd = `ad run maintenance.list --profile ${profile} --json`;
  if (repoPath) {
    cmd += ` -- path="${escapeQuotes(repoPath)}"`;
  }
  const { stdout } = await execFn(cmd);
  const parsed = JSON.parse(stdout);
  if (parsed.ok === false && parsed.error) {
    throw new Error(parsed.error.message || `ActionDock 错误: ${parsed.error.code}`);
  }
  return parsed.data ?? parsed;
}

/**
 * 查询待审池候选列表
 */
export async function queryRemoteInboxList(
  profile: string = "skm",
  execFn: (cmd: string) => Promise<{ stdout: string; stderr: string }> = defaultExec
): Promise<any[]> {
  const cmd = `ad run knowledge.list --profile ${profile} --json -- status="pending"`;
  const { stdout } = await execFn(cmd);
  const parsed = JSON.parse(stdout);
  if (parsed.ok === false && parsed.error) {
    throw new Error(parsed.error.message || `ActionDock 错误: ${parsed.error.code}`);
  }
  const data = parsed.data ?? parsed;
  return Array.isArray(data.items) ? data.items : [];
}

/**
 * 异步触发派发命令（非阻塞启动外部智能体）
 */
export function triggerDispatch(command: string, { timeoutMs = 1500, execFn = null }: { timeoutMs?: number; execFn?: ((cmd: string) => any) | null } = {}): Promise<any> {
  if (execFn) {
    return Promise.resolve(execFn(command));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    let isSettled = false;

    child.on("error", (err: Error) => {
      if (!isSettled) {
        isSettled = true;
        reject(err);
      }
    });

    child.on("exit", (code: number | null) => {
      if (!isSettled) {
        isSettled = true;
        if (code !== 0 && code !== null) {
          reject(new Error(`派发命令异常退出，退出码 ${code}: ${output.trim()}`));
        } else {
          resolve({ pid: child.pid, output: output.trim(), exited: true });
        }
      }
    });

    setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        resolve({ pid: child.pid, output: output.trim(), exited: false });
      }
    }, timeoutMs);
  });
}

/**
 * 生成结算 Markdown 报告
 */
export function generateMarkdownReport(reportData: {
  profile?: string;
  total?: number;
  completed?: number;
  skipped?: number;
  failed?: number;
  totalElapsedMs?: number;
  results?: RepoResult[];
  inboxTotal?: number;
  inboxCompleted?: number;
  inboxFailed?: number;
  inboxSkipped?: boolean;
  inboxResults?: InboxCandidateResult[];
} = {}): string {
  const {
    profile = "skm",
    total = 0,
    completed = 0,
    skipped = 0,
    failed = 0,
    totalElapsedMs = 0,
    results = [],
    inboxTotal = 0,
    inboxCompleted = 0,
    inboxFailed = 0,
    inboxSkipped = false,
    inboxResults = [],
  } = reportData;

  const totalDurationStr = formatDuration(totalElapsedMs);

  let md = `# 知识维护流水线执行报告\n\n`;
  md += `- 执行环境配置：${profile}\n`;
  md += `- 扫描总仓库数：${total}\n`;
  md += `- 维护成功数：${completed}\n`;
  md += `- 跳过无需更新数：${skipped}\n`;
  md += `- 失败或超时数：${failed}\n`;
  md += `- 待审候选总数：${inboxTotal}\n`;
  md += `- 待审成功归档数：${inboxCompleted}\n`;
  md += `- 待审处理失败数：${inboxFailed}\n`;
  if (inboxSkipped) {
    md += `- 待审池状态：已跳过\n`;
  }
  md += `- 流水线总耗时：${totalDurationStr}\n\n`;
  md += `## 仓库执行明细\n\n`;

  if (results.length === 0) {
    md += `- 无待处理仓库明细记录\n`;
  } else {
    for (const r of results) {
      const statusText =
        r.status === "completed"
          ? "成功闭环"
          : r.status === "skipped"
          ? "无需更新"
          : "执行失败";
      const durationStr = formatDuration(r.durationMs || 0);
      const repoTypeLabel = r.repoType === "system_knowledge" ? "系统知识库" : "业务代码仓";
      md += `- 仓库标识：${r.repo}（${repoTypeLabel}）\n`;
      md += `  - 远端路径：${r.path}\n`;
      md += `  - 执行状态：${statusText}\n`;
      if (r.targetCommit) {
        md += `  - 目标检查点：${r.targetCommit}\n`;
      }
      md += `  - 耗时：${durationStr}\n`;
      if (r.message) {
        md += `  - 说明：${r.message}\n`;
      }
    }
  }

  md += `\n## 待审池处理明细\n\n`;
  if (inboxSkipped) {
    md += `- 待审池阶段已按配置跳过巡检\n`;
  } else if (inboxResults.length === 0) {
    md += `- 待审池无待处理候选文档\n`;
  } else {
    md += `| 候选标识 | 候选标题 | 文件名 | 状态 | 耗时 | 说明 |\n`;
    md += `|---|---|---|---|---|---|\n`;
    for (const item of inboxResults) {
      const statusText = item.status === "completed" ? "成功归档" : "处理失败";
      const durationStr = formatDuration(item.durationMs || 0);
      const note = item.status === "completed" ? "已完成归档闭环" : (item.error || "处理失败");
      const safeTitle = (item.title || "").replace(/\|/g, "\\|");
      const safeFilename = (item.filename || "").replace(/\|/g, "\\|");
      const safeNote = (note || "").replace(/\|/g, "\\|");
      md += `| ${item.id} | ${safeTitle} | ${safeFilename} | ${statusText} | ${durationStr} | ${safeNote} |\n`;
    }
  }

  return md;
}

/**
 * 打印帮助信息
 */
export function printHelp(): void {
  console.log(`知识维护流水线调度与异步观测驱动器 (Pipeline Runner)

用法：
  ad run orchestrator.pipeline [选项]

选项：
  --profile <name>         ActionDock 远端客户端配置标识 (默认: "skm")
  --dispatch-cmd <cmd>     外部智能体派发命令模版 (在实际运行时必填，--dry-run 时可选)
  --timeout <minutes>      单仓等待检查点推进超时时间 (分钟，默认: 15)
  --interval <seconds>     远端检查点轮询探测间隔 (秒，默认: 10)
  --dry-run                预演模式，仅扫描远端变更并打印渲染后的派发命令，不实际触发与轮询
  --only <repos>           仅处理指定的单个或几个仓库 (逗号分隔，如 "order-service,cron-service")
  --skip-system-knowledge  跳过系统知识库第二阶段全局维护 (默认: false)
  --skip-inbox             跳过第三阶段 Knowledge Inbox 待审池巡检消费 (默认: false)
  --report-file <path>     最终 Markdown 结算报告输出路径 (默认: "maintenance-report.md")
  --log-file <path>        实时日志流追加路径 (支持 tail -f 实时观测)
  -h, --help               显示帮助信息与命令模版占位符列表

模版占位符列表：
  {{repo}}                 仓库标识/名称 (例如 "order-service")
  {{path}}                 远端工作区绝对路径 (例如 "/srv/workspace/order-service")
  {{branch}}               目标分支名 (例如 "release")
  {{repoType}}             仓库架构类型 (code 或 system_knowledge)
  {{from}}                 前置检查点 commit hash (初始建库时为 "initial")
  {{to}}                   目标最新 HEAD commit hash
  {{commitCount}}          待核验的新增提交总数
  {{changedFilesCount}}    变动文件总数
  {{diffSummary}}          文件变动统计摘要文本
  {{commitsSummary}}       格式化的提交日志摘要文本
  {{codePhaseSummary}}     前序已完成巡检的代码仓摘要与变更清单
  {{prompt}}               开箱即用的专业维护指导语模版 (代码仓、系统知识库或待审候选自动适配)
  {{candidateId}}          当前待审候选文档标识 (例如 "20260924-a1b2c3")
  {{candidateTitle}}       当前待审候选文档标题
  {{candidateFilename}}    当前待审候选文档文件名

调用范例：
  - 本地 Action 派发：
    ad run orchestrator.pipeline -- profile="skm" dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"'

  - 实时落盘日志与 Tail 观测：
    ad run orchestrator.pipeline -- profile="skm" logFile="/var/log/knowledge-pipeline.log" dispatchCmd='...'

  - 预演检查：
    ad run orchestrator.pipeline -- dryRun:=true

`);
}

/**
 * 第三阶段：Knowledge Inbox 全局待审池串行巡检与消费
 */
export async function runInboxPhase(
  options: PipelineOptions,
  hooks: PipelineHooks = {},
  extraContext: {
    startTime?: number;
    codeReposCount?: number;
    systemReposCount?: number;
    writeLog?: (msg: string) => void;
  } = {}
): Promise<InboxPhaseSummary> {
  const {
    execFn = defaultExec,
    dispatchFn = null,
    sleepFn = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    onProgress = null,
    nowFn = Date.now,
  } = hooks;

  const profile = options.profile || "skm";
  const timeoutVal = options.timeout ?? 15;
  const intervalVal = options.interval ?? 10;
  const timeoutMs = timeoutVal * 60 * 1000;
  const intervalMs = intervalVal * 1000;
  const startTime = extraContext.startTime ?? nowFn();
  const writeLog = extraContext.writeLog ?? (() => {});

  // 1. 若配置跳过待审池，直接结算跳过
  if (options.skipInbox) {
    writeLog("[PHASE3] skipInbox 为 true，跳过 Knowledge Inbox 待审池阶段");
    return {
      inboxTotal: 0,
      inboxCompleted: 0,
      inboxFailed: 0,
      inboxSkipped: true,
      inboxResults: [],
    };
  }

  // 2. 执行查询：调用 knowledge.list (status="pending") 获取待审候选列表
  writeLog("正在扫描 Knowledge Inbox 待审池候选列表...");
  let pendingItems: any[] = [];
  try {
    pendingItems = await queryRemoteInboxList(profile, execFn);
  } catch (err: any) {
    writeLog(`[ERROR] 查询待审池候选列表失败: ${err.message}`);
    return {
      inboxTotal: 0,
      inboxCompleted: 0,
      inboxFailed: 0,
      inboxSkipped: false,
      inboxResults: [],
    };
  }

  const inboxTotal = pendingItems.length;
  writeLog(`待审池扫描完成，发现待审候选共 ${inboxTotal} 篇`);

  // 3. 若无待审候选，直接跳过并结算
  if (inboxTotal === 0) {
    writeLog("[PHASE3] 待审池为空，无待处理候选文档，直接结算完成");
    return {
      inboxTotal: 0,
      inboxCompleted: 0,
      inboxFailed: 0,
      inboxSkipped: false,
      inboxResults: [],
    };
  }

  const inboxResults: InboxCandidateResult[] = [];
  let inboxCompleted = 0;
  let inboxFailed = 0;

  // 4. 串行循环派发：逐个候选唤醒 Agent 处理并轮询探测移出 pending
  for (let i = 0; i < pendingItems.length; i++) {
    const candidate = pendingItems[i];
    const candidateId = candidate.id || "";
    const candidateTitle = candidate.title || candidate.filename || candidateId;
    const candidateFilename = candidate.filename || "";
    const candidateStartTime = nowFn();

    const reportProgress = () => {
      const activeCandidateElapsed = nowFn() - candidateStartTime;
      const totalElapsed = nowFn() - startTime;
      const stats = {
        total: (extraContext.codeReposCount ?? 0) + (extraContext.systemReposCount ?? 0),
        processed: (extraContext.codeReposCount ?? 0) + (extraContext.systemReposCount ?? 0),
        skipped: 0,
        completed: (extraContext.codeReposCount ?? 0) + (extraContext.systemReposCount ?? 0),
        failed: 0,
        totalElapsed,
        inboxTotal,
        inboxProcessed: inboxCompleted + inboxFailed,
        inboxCompleted,
        inboxFailed,
        inboxSkipped: false,
        activeCandidate: `${candidateId} (${candidateTitle})`,
        activeCandidateElapsed,
      };
      if (onProgress) {
        onProgress(stats);
      }
    };

    reportProgress();

    // 组装指导语模版与占位符并渲染派发命令
    const placeholders = buildInboxPlaceholders(candidate);
    const renderedCmd = options.dispatchCmd
      ? renderTemplate(options.dispatchCmd, placeholders, { escapeQuotes: true })
      : "";

    writeLog(`[DISPATCH] 派发待审候选任务 (${i + 1}/${inboxTotal}) -> ID: ${candidateId}, 标题: ${candidateTitle}`);

    try {
      if (dispatchFn) {
        await dispatchFn(renderedCmd, placeholders);
      } else if (renderedCmd) {
        await triggerDispatch(renderedCmd);
      }
    } catch (err: any) {
      inboxFailed++;
      const durationMs = nowFn() - candidateStartTime;
      writeLog(`[ERROR] 待审候选 ${candidateId} 派发异常: ${err.message}`);
      inboxResults.push({
        id: candidateId,
        filename: candidateFilename,
        title: candidateTitle,
        durationMs,
        status: "failed",
        error: `派发执行异常: ${err.message}`,
      });
      continue;
    }

    // 轮询探测：定期调用 knowledge.list(status: "pending")，检查当前 candidate.id 是否已移出待审池
    let isArchived = false;
    let isTimedOut = false;

    while (!isArchived && !isTimedOut) {
      reportProgress();
      await sleepFn(intervalMs);

      const elapsed = nowFn() - candidateStartTime;
      if (elapsed >= timeoutMs) {
        isTimedOut = true;
        break;
      }

      try {
        const currentPending = await queryRemoteInboxList(profile, execFn);
        const stillPending = currentPending.some(
          (item: any) => item.id === candidateId || item.filename === candidateFilename
        );
        if (!stillPending) {
          isArchived = true;
          break;
        }
      } catch {
        // 网络抖动不中断轮询，持续等待至超时
      }
    }

    const durationMs = nowFn() - candidateStartTime;

    if (isArchived) {
      inboxCompleted++;
      writeLog(`[SUCCESS] 待审候选 ${candidateId} 归档成功 (耗时: ${formatDuration(durationMs)})`);
      inboxResults.push({
        id: candidateId,
        filename: candidateFilename,
        title: candidateTitle,
        durationMs,
        status: "completed",
        error: null,
      });
    } else {
      inboxFailed++;
      writeLog(`[TIMEOUT] 待审候选 ${candidateId} 归档超时 (${timeoutVal} 分钟)`);
      inboxResults.push({
        id: candidateId,
        filename: candidateFilename,
        title: candidateTitle,
        durationMs,
        status: "failed",
        error: `等待候选归档超时 (${timeoutVal} 分钟)，未检测到移出待审池`,
      });
    }
  }

  writeLog(`[PHASE3] Knowledge Inbox 待审池巡检消费完毕：总数 ${inboxTotal} 篇，成功归档 ${inboxCompleted} 篇，失败 ${inboxFailed} 篇`);

  return {
    inboxTotal,
    inboxCompleted,
    inboxFailed,
    inboxSkipped: false,
    inboxResults,
  };
}

/**
 * 核心调度流水线（支持单仓代码巡检、系统知识库全局聚合与待审池巡检三阶段调度）
 */
export async function runPipeline(
  options: PipelineOptions,
  hooks: PipelineHooks = {}
): Promise<DryRunResult | PipelineSummary> {
  const {
    execFn = defaultExec,
    dispatchFn = null,
    sleepFn = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    onProgress = null,
    logFn = null,
    nowFn = Date.now,
  } = hooks;

  const profile = options.profile || "skm";
  const timeoutVal = options.timeout ?? 15;
  const intervalVal = options.interval ?? 10;
  const startTime = nowFn();

  const writeLog = (msg: string) => {
    if (logFn) {
      logFn(msg);
    }
    if (options.logFile) {
      try {
        const ts = new Date(nowFn()).toISOString().replace("T", " ").replace(/\..+/, "");
        fs.appendFileSync(options.logFile, `[${ts}] ${msg}\n`, "utf8");
      } catch {
        // 容错处理
      }
    }
  };

  writeLog(`开始执行知识维护流水线 (profile=${profile})`);

  // 1. 扫描远端全量或单仓状态
  writeLog("正在扫描远端受管仓库状态与检查点基线...");
  const scanData = await queryRemoteList(profile, null, execFn);

  let allRepos: any[] = [];
  if (Array.isArray(scanData.results)) {
    allRepos = scanData.results;
  } else if (scanData.path) {
    allRepos = [scanData];
  }

  // 2. 按 --only 进行过滤
  if (options.only) {
    const onlySet = new Set(
      options.only
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
    allRepos = allRepos.filter((item) => {
      const repoName = (item.repo || path.basename(item.path || "")).toLowerCase();
      return onlySet.has(repoName);
    });
  }

  // 3. 区分单代码仓 (Phase 1) 与系统知识仓 (Phase 2)
  const codeRepos: any[] = [];
  const systemRepos: any[] = [];

  for (const item of allRepos) {
    const repoName = item.repo || (item.path ? path.basename(item.path) : "");
    const rawType = item.repoType || "";
    const repoType =
      rawType === "system_knowledge" || rawType === "code"
        ? rawType
        : (repoName.toLowerCase().includes("system-knowledge") ||
           repoName.toLowerCase().includes("knowledge-system") ||
           (item.path && (item.path.toLowerCase().includes("system-knowledge") || item.path.toLowerCase().includes("knowledge-system")))
            ? "system_knowledge"
            : "code");

    const enrichedItem = { ...item, repoType };

    if (repoType === "system_knowledge") {
      if (!options.skipSystemKnowledge) {
        systemRepos.push(enrichedItem);
      }
    } else {
      codeRepos.push(enrichedItem);
    }
  }

  // 确保按阶段顺序执行：先单仓代码巡检，后全局系统知识聚合
  const orderedRepos = [...codeRepos, ...systemRepos];

  const results: RepoResult[] = [];
  let skippedCount = 0;
  let completedCount = 0;
  let failedCount = 0;

  // 4. 预演模式处理
  if (options.dryRun) {
    const dryRunOutput: DryRunItem[] = [];
    const pendingCodeRepos: any[] = [];

    for (const item of codeRepos) {
      if (item.status === "error") {
        failedCount++;
      } else if (!item.hasChanges && item.status !== "initial" && item.status !== "changed") {
        skippedCount++;
      } else {
        pendingCodeRepos.push(item);
      }
    }

    for (const item of pendingCodeRepos) {
      const placeholders = buildPlaceholders(item);
      const renderedCmd = options.dispatchCmd
        ? renderTemplate(options.dispatchCmd, placeholders, { escapeQuotes: true })
        : `[未指定 --dispatch-cmd] 目标仓库: ${placeholders.repo}, 待核验提交数: ${placeholders.commitCount}`;
      dryRunOutput.push({
        repo: placeholders.repo,
        path: placeholders.path,
        repoType: placeholders.repoType,
        renderedCommand: renderedCmd,
        placeholders,
      });
    }

    const codePhaseSummaryForDryRun =
      pendingCodeRepos.length > 0
        ? `预演阶段待更新代码仓共 ${pendingCodeRepos.length} 个：` + pendingCodeRepos.map((r) => r.repo || path.basename(r.path || "")).join(", ")
        : "所有代码仓均无变更。";

    for (const item of systemRepos) {
      if (item.status === "error") {
        failedCount++;
      } else if (!item.hasChanges && item.status !== "initial" && item.status !== "changed" && pendingCodeRepos.length === 0 && !options.only) {
        skippedCount++;
      } else {
        const placeholders = buildPlaceholders(item, { codePhaseSummary: codePhaseSummaryForDryRun });
        const renderedCmd = options.dispatchCmd
          ? renderTemplate(options.dispatchCmd, placeholders, { escapeQuotes: true })
          : `[未指定 --dispatch-cmd] 目标系统仓: ${placeholders.repo}`;
        dryRunOutput.push({
          repo: placeholders.repo,
          path: placeholders.path,
          repoType: placeholders.repoType,
          renderedCommand: renderedCmd,
          placeholders,
        });
      }
    }

    return {
      dryRun: true,
      total: orderedRepos.length,
      skipped: skippedCount,
      pending: dryRunOutput.length,
      dryRunOutput,
      inboxTotal: 0,
      inboxCompleted: 0,
      inboxFailed: 0,
      inboxSkipped: options.skipInbox ?? false,
      inboxResults: [],
    };
  }

  // 5. 校验必填参数
  if (!options.dispatchCmd) {
    throw new Error("缺少必需参数：--dispatch-cmd <template>。实际运行时必须提供派发命令模版。");
  }

  // 6. 执行调度辅助处理函数
  const timeoutMs = timeoutVal * 60 * 1000;
  const intervalMs = intervalVal * 1000;

  const processRepoDispatch = async (repoItem: any, placeholders: Record<string, any>) => {
    const repoName = placeholders.repo;
    const targetCommit = placeholders.to;
    const repoType = placeholders.repoType || "code";
    const repoStartTime = nowFn();

    const reportProgress = () => {
      const activeRepoElapsed = nowFn() - repoStartTime;
      const totalElapsed = nowFn() - startTime;
      const stats = {
        total: orderedRepos.length,
        processed: skippedCount + completedCount + failedCount,
        skipped: skippedCount,
        completed: completedCount,
        failed: failedCount,
        activeRepo: repoName,
        activeRepoElapsed,
        totalElapsed,
      };
      if (onProgress) {
        onProgress(stats);
      }
    };

    reportProgress();

    // 渲染派发命令并触发
    const renderedCmd = renderTemplate(options.dispatchCmd!, placeholders, { escapeQuotes: true });
    writeLog(`[DISPATCH] 派发维护任务 -> 仓库: ${repoName} (${repoType}), 目标检查点: ${targetCommit}`);

    try {
      if (dispatchFn) {
        await dispatchFn(renderedCmd, placeholders);
      } else {
        await triggerDispatch(renderedCmd);
      }
    } catch (err: any) {
      failedCount++;
      writeLog(`[ERROR] 仓库 ${repoName} 派发异常: ${err.message}`);
      results.push({
        repo: repoName,
        path: repoItem.path,
        repoType,
        status: "failed",
        targetCommit,
        durationMs: nowFn() - repoStartTime,
        message: `派发执行异常: ${err.message}`,
      });
      return;
    }

    // 进入异步状态侦听循环
    let isFinished = false;
    let isTimedOut = false;

    while (!isFinished && !isTimedOut) {
      reportProgress();

      await sleepFn(intervalMs);

      const elapsed = nowFn() - repoStartTime;
      if (elapsed >= timeoutMs) {
        isTimedOut = true;
        break;
      }

      try {
        const currentStatus = await queryRemoteList(profile, repoItem.path, execFn);
        if (isRepoCompleted(currentStatus, targetCommit, { dispatchedAt: repoStartTime })) {
          isFinished = true;
          break;
        }
      } catch (err) {
        // 网络抖动不中断轮询，持续等待至超时
      }
    }

    const durationMs = nowFn() - repoStartTime;

    if (isFinished) {
      completedCount++;
      writeLog(`[SUCCESS] 仓库 ${repoName} 检查点推进成功: ${targetCommit} (耗时: ${formatDuration(durationMs)})`);
      results.push({
        repo: repoName,
        path: repoItem.path,
        repoType,
        status: "completed",
        targetCommit,
        durationMs,
        message: `检查点已成功推进至 ${targetCommit || "最新水位"}`,
      });
    } else {
      failedCount++;
      writeLog(`[TIMEOUT] 仓库 ${repoName} 推进超时 (${timeoutVal} 分钟)`);
      results.push({
        repo: repoName,
        path: repoItem.path,
        repoType,
        status: "failed",
        targetCommit,
        durationMs,
        message: `等待检查点推进超时 (${timeoutVal} 分钟)，未检测到 ${targetCommit || "推进记录"}`,
      });
    }
  };

  // 7. 第一阶段：单仓代码巡检与知识维护
  writeLog(`[PHASE1] 开始第一阶段：单仓代码巡检 (待处理仓数: ${codeRepos.length})`);
  for (const repoItem of codeRepos) {
    const repoName = repoItem.repo || (repoItem.path ? path.basename(repoItem.path) : "");
    if (repoItem.status === "error") {
      failedCount++;
      writeLog(`[ERROR] 仓库 ${repoName} 扫描失败: ${repoItem.message || "unknown error"}`);
      results.push({
        repo: repoName,
        path: repoItem.path,
        repoType: "code",
        status: "failed",
        targetCommit: repoItem.to || repoItem.from || "",
        durationMs: 0,
        message: `远端扫描失败: ${repoItem.message || "unknown error"}`,
      });
    } else if (!repoItem.hasChanges && repoItem.status !== "initial" && repoItem.status !== "changed") {
      skippedCount++;
      writeLog(`[SKIP] 仓库 ${repoName} (code) 检查点已对齐，跳过`);
      results.push({
        repo: repoName,
        path: repoItem.path,
        repoType: "code",
        status: "skipped",
        targetCommit: repoItem.to || repoItem.from || "",
        durationMs: 0,
        message: "远端检查点已对齐，无待核验代码变更",
      });
    } else {
      const placeholders = buildPlaceholders(repoItem);
      await processRepoDispatch(repoItem, placeholders);
    }
  }

  // 8. 汇总第一阶段巡检成果，为系统知识库提供事实输入
  const updatedCodeRepos = results.filter((r) => r.status === "completed" && r.repoType !== "system_knowledge");
  let codePhaseSummary = "";
  if (updatedCodeRepos.length > 0) {
    codePhaseSummary =
      `前序已完成巡检且发生更新的代码仓（共 ${updatedCodeRepos.length} 个）：\n` +
      updatedCodeRepos.map((r) => `- ${r.repo}：已推进检查点至 ${r.targetCommit || "HEAD"}`).join("\n");
  } else {
    codePhaseSummary = "前序代码仓巡检完毕，所有代码仓均无变更或无需更新文档。";
  }

  // 9. 第二阶段：系统知识库全局聚合维护
  if (systemRepos.length > 0) {
    writeLog(`[PHASE2] 开始第二阶段：系统知识库全局聚合维护 (系统仓数: ${systemRepos.length}, 前序更新数: ${updatedCodeRepos.length})`);
  }
  for (const repoItem of systemRepos) {
    const repoName = repoItem.repo || (repoItem.path ? path.basename(repoItem.path) : "");
    if (repoItem.status === "error") {
      failedCount++;
      writeLog(`[ERROR] 系统知识库 ${repoName} 扫描失败: ${repoItem.message || "unknown error"}`);
      results.push({
        repo: repoName,
        path: repoItem.path,
        repoType: "system_knowledge",
        status: "failed",
        targetCommit: repoItem.to || repoItem.from || "",
        durationMs: 0,
        message: `远端扫描失败: ${repoItem.message || "unknown error"}`,
      });
    } else if (
      !repoItem.hasChanges &&
      repoItem.status !== "initial" &&
      repoItem.status !== "changed" &&
      updatedCodeRepos.length === 0 &&
      !options.only
    ) {
      skippedCount++;
      writeLog(`[SKIP] 系统知识库 ${repoName} 前序代码仓无更新且基线已对齐，跳过`);
      results.push({
        repo: repoName,
        path: repoItem.path,
        repoType: "system_knowledge",
        status: "skipped",
        targetCommit: repoItem.to || repoItem.from || "",
        durationMs: 0,
        message: "前序代码仓均无变更且系统知识基线已对齐，跳过系统层维护",
      });
    } else {
      const placeholders = buildPlaceholders(repoItem, { codePhaseSummary });
      await processRepoDispatch(repoItem, placeholders);
    }
  }

  // 10. 第三阶段：Knowledge Inbox 全局待审池串行巡检与消费
  writeLog(`[PHASE3] 开始第三阶段：Knowledge Inbox 全局待审池巡检与消费`);
  const inboxSummary = await runInboxPhase(options, hooks, {
    startTime,
    codeReposCount: codeRepos.length,
    systemReposCount: systemRepos.length,
    writeLog,
  });

  const totalElapsedMs = nowFn() - startTime;
  writeLog(
    `[SUMMARY] 流水线执行完毕：仓库总计 ${orderedRepos.length} 个（完成 ${completedCount}，跳过 ${skippedCount}，失败 ${failedCount}），待审池候选总计 ${inboxSummary.inboxTotal} 篇（归档 ${inboxSummary.inboxCompleted}，失败 ${inboxSummary.inboxFailed}），总耗时 ${formatDuration(totalElapsedMs)}`
  );

  const summary = {
    profile,
    total: orderedRepos.length,
    completed: completedCount,
    skipped: skippedCount,
    failed: failedCount,
    totalElapsedMs,
    results,
    logFile: options.logFile ?? null,
    success: failedCount === 0 && inboxSummary.inboxFailed === 0,
    inboxTotal: inboxSummary.inboxTotal,
    inboxCompleted: inboxSummary.inboxCompleted,
    inboxFailed: inboxSummary.inboxFailed,
    inboxSkipped: inboxSummary.inboxSkipped,
    inboxResults: inboxSummary.inboxResults,
  };

  const mdReport = generateMarkdownReport(summary);

  let reportSaved = true;
  if (options.reportFile) {
    try {
      fs.writeFileSync(options.reportFile, mdReport, "utf8");
      writeLog(`[REPORT] 结算报告已成功保存至 ${options.reportFile}`);
    } catch (err: any) {
      reportSaved = false;
      writeLog(`[WARN] 结算报告写入失败: ${options.reportFile} (${err.message})`);
    }
  }

  return {
    ...summary,
    markdownReport: mdReport,
    reportSaved,
  };
}
