#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import process from "node:process";

const execAsync = promisify(exec);

/**
 * 命令行参数解析
 */
export function parseArgs(argv = []) {
  const options = {
    profile: "skm",
    dispatchCmd: "",
    timeout: 15,
    interval: 10,
    dryRun: false,
    only: null,
    reportFile: "maintenance-report.md",
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
    } else if (arg === "--report-file") {
      options.reportFile = argv[++i] ?? options.reportFile;
    } else if (arg.startsWith("--report-file=")) {
      options.reportFile = arg.slice("--report-file=".length);
    }
  }

  return options;
}

/**
 * 安全引号转义，避免在 Shell 命令双引号字符串中插值时破裂。
 * 除双引号与反斜杠外，同时转义 $ 与反引号，阻断 $() 、 ${} 与 `` 展开注入。
 */
export function escapeQuotes(val) {
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
export function formatDuration(ms = 0) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 进度条字符串渲染
 */
export function renderProgressBar(current = 0, total = 0, width = 20) {
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
export function renderDashboard(stats) {
  const progressBar = renderProgressBar(stats.processed, stats.total);
  const lines = [
    `流水线进度: ${progressBar}`,
    `总仓数: ${stats.total} | 已跳过: ${stats.skipped} | 已完成: ${stats.completed} | 失败: ${stats.failed}`,
    stats.activeRepo
      ? `当前活跃仓: ${stats.activeRepo} | 单仓耗时: ${formatDuration(stats.activeRepoElapsed)} | 总耗时: ${formatDuration(stats.totalElapsed)}`
      : `总耗时: ${formatDuration(stats.totalElapsed)}`,
  ];
  return lines.join("\n");
}

/**
 * 构造开箱即用的专业单仓维护指导语模版
 */
export function buildPrompt(data) {
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
    `  - 局部编辑：ad run workspace/files.edit --profile skm -- path="${repoPath}/<file>" targetContent="<old>" replacementContent="<new>"`,
    `  - 安全写入：ad run workspace/files.write --profile skm -- path="${repoPath}/<file>" content="<content>"`,
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
 * 从扫描条目抽取全量模版占位符
 */
export function buildPlaceholders(item = {}) {
  const repo = item.repo || (item.path ? path.basename(item.path) : "");
  const repoPath = item.path || "";
  const branch = item.branch || "master";
  const from = item.from || "initial";
  const to = item.to || "";
  const commitCount = item.commitCount ?? (Array.isArray(item.commits) ? item.commits.length : 0);

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
      .map((c) => `${c.shortHash || c.hash?.slice(0, 7) || ""} ${c.message || ""}`.trim())
      .join("\n");
  } else if (item.initialInventoryRequired) {
    commitsSummary = "冷启动建库：无历史检查点基线";
  } else {
    commitsSummary = "无新增提交";
  }

  const prompt = buildPrompt({
    repo,
    path: repoPath,
    branch,
    from,
    to,
    commitCount,
    changedFilesCount,
    diffSummary,
    commitsSummary,
  });

  return {
    repo,
    path: repoPath,
    branch,
    from,
    to,
    commitCount,
    changedFilesCount,
    diffSummary,
    commitsSummary,
    prompt,
  };
}

/**
 * 模版插值替换引擎，支持安全引号转义
 */
export function renderTemplate(template = "", vars = {}, options = {}) {
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
export function isRepoCompleted(statusResult, targetCommit) {
  if (!statusResult) return false;
  const data = statusResult.data || statusResult;

  if (targetCommit) {
    const currentFrom = data.from ? String(data.from).trim() : null;
    const target = String(targetCommit).trim();
    if (currentFrom && (currentFrom === target || currentFrom.startsWith(target) || target.startsWith(currentFrom))) {
      return true;
    }
  }

  if (data.status === "upToDate") {
    return true;
  }

  if (data.hasChanges === false && data.status !== "error") {
    return true;
  }

  return false;
}

/**
 * 默认命令执行函数（基于 child_process.exec）
 */
export async function defaultExec(cmd) {
  return execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
}

/**
 * 侦听远端检查点与变更状态
 */
export async function queryRemoteList(profile = "skm", repoPath = null, execFn = defaultExec) {
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
 * 异步触发派发命令（非阻塞启动外部智能体）
 */
export function triggerDispatch(command, { timeoutMs = 1500, execFn = null } = {}) {
  if (execFn) {
    return Promise.resolve(execFn(command));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });

    let isSettled = false;

    child.on("error", (err) => {
      if (!isSettled) {
        isSettled = true;
        reject(err);
      }
    });

    child.on("exit", (code) => {
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
export function generateMarkdownReport(reportData = {}) {
  const {
    profile = "skm",
    total = 0,
    completed = 0,
    skipped = 0,
    failed = 0,
    totalElapsedMs = 0,
    results = [],
  } = reportData;

  const totalDurationStr = formatDuration(totalElapsedMs);

  let md = `# 知识维护流水线执行报告\n\n`;
  md += `- 执行环境配置：${profile}\n`;
  md += `- 扫描总仓库数：${total}\n`;
  md += `- 维护成功数：${completed}\n`;
  md += `- 跳过无需更新数：${skipped}\n`;
  md += `- 失败或超时数：${failed}\n`;
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
      md += `- 仓库标识：${r.repo}\n`;
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

  return md;
}

/**
 * 打印帮助信息
 */
export function printHelp() {
  console.log(`知识维护流水线调度与异步观测驱动器 (Pipeline Runner)

用法：
  pipeline-runner [选项]

选项：
  --profile <name>         ActionDock 远端客户端配置标识 (默认: "skm")
  --dispatch-cmd <cmd>     外部智能体派发命令模版 (在实际运行时必填，--dry-run 时可选)
  --timeout <minutes>      单仓等待检查点推进超时时间 (分钟，默认: 15)
  --interval <seconds>     远端检查点轮询探测间隔 (秒，默认: 10)
  --dry-run                预演模式，仅扫描远端变更并打印渲染后的派发命令，不实际触发与轮询
  --only <repos>           仅处理指定的单个或几个仓库 (逗号分隔，如 "order-service,cron-service")
  --report-file <path>     最终 Markdown 结算报告输出路径 (默认: "maintenance-report.md")
  -h, --help               显示帮助信息与命令模版占位符列表

模版占位符列表：
  {{repo}}                 仓库标识/名称 (例如 "order-service")
  {{path}}                 远端工作区绝对路径 (例如 "/srv/workspace/order-service")
  {{branch}}               目标分支名 (例如 "release")
  {{from}}                 前置检查点 commit hash (初始建库时为 "initial")
  {{to}}                   目标最新 HEAD commit hash
  {{commitCount}}          待核验的新增提交总数
  {{changedFilesCount}}    变动文件总数
  {{diffSummary}}          文件变动统计摘要文本
  {{commitsSummary}}       格式化的提交日志摘要文本
  {{prompt}}               开箱即用的专业单仓维护指导语模版

调用范例：
  - Action 派发：
    ./bin/pipeline-runner.mjs --dispatch-cmd 'ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"'

  - HTTP 接口派发：
    ./bin/pipeline-runner.mjs --dispatch-cmd 'curl -s -X POST https://agent.internal/api/dispatch -d "{\\"repo\\": \\"{{repo}}\\", \\"to\\": \\"{{to}}\\"}"'

  - 预演检查：
    ./bin/pipeline-runner.mjs --dry-run
`);
}

/**
 * 核心调度流水线
 */
export async function runPipeline(options, hooks = {}) {
  const {
    execFn = defaultExec,
    dispatchFn = null,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onProgress = null,
    nowFn = Date.now,
  } = hooks;

  const startTime = nowFn();

  // 1. 扫描远端全量或单仓状态
  const scanData = await queryRemoteList(options.profile, null, execFn);

  let allRepos = [];
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

  const results = [];
  let skippedCount = 0;
  let completedCount = 0;
  let failedCount = 0;

  // 3. 统计并区分待处理仓库与已就绪仓库
  const pendingRepos = [];
  for (const item of allRepos) {
    const repoName = item.repo || (item.path ? path.basename(item.path) : "");
    if (item.status === "error") {
      // 扫描阶段的真实故障必须计为失败，严禁伪装成“已对齐跳过”
      failedCount++;
      results.push({
        repo: repoName,
        path: item.path,
        status: "failed",
        targetCommit: item.to || item.from || "",
        durationMs: 0,
        message: `远端扫描失败: ${item.message || "unknown error"}`,
      });
    } else if (!item.hasChanges && item.status !== "initial" && item.status !== "changed") {
      skippedCount++;
      results.push({
        repo: repoName,
        path: item.path,
        status: "skipped",
        targetCommit: item.to || item.from || "",
        durationMs: 0,
        message: "远端检查点已对齐，无待核验代码变更",
      });
    } else {
      pendingRepos.push(item);
    }
  }

  // 4. 预演模式处理
  if (options.dryRun) {
    const dryRunOutput = [];
    for (const item of pendingRepos) {
      const placeholders = buildPlaceholders(item);
      const renderedCmd = options.dispatchCmd
        ? renderTemplate(options.dispatchCmd, placeholders, { escapeQuotes: true })
        : `[未指定 --dispatch-cmd] 目标仓库: ${placeholders.repo}, 待核验提交数: ${placeholders.commitCount}`;
      dryRunOutput.push({
        repo: placeholders.repo,
        path: placeholders.path,
        renderedCommand: renderedCmd,
        placeholders,
      });
    }

    return {
      dryRun: true,
      total: allRepos.length,
      skipped: skippedCount,
      pending: pendingRepos.length,
      dryRunOutput,
    };
  }

  // 5. 校验必填参数
  if (!options.dispatchCmd) {
    throw new Error("缺少必需参数：--dispatch-cmd <template>。实际运行时必须提供派发命令模版。");
  }

  // 6. 依次处理待办仓库队列
  const timeoutMs = options.timeout * 60 * 1000;
  const intervalMs = options.interval * 1000;

  for (let idx = 0; idx < pendingRepos.length; idx++) {
    const repoItem = pendingRepos[idx];
    const placeholders = buildPlaceholders(repoItem);
    const repoName = placeholders.repo;
    const targetCommit = placeholders.to;
    const repoStartTime = nowFn();

    const reportProgress = () => {
      const activeRepoElapsed = nowFn() - repoStartTime;
      const totalElapsed = nowFn() - startTime;
      const stats = {
        total: allRepos.length,
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
    const renderedCmd = renderTemplate(options.dispatchCmd, placeholders, { escapeQuotes: true });

    try {
      if (dispatchFn) {
        await dispatchFn(renderedCmd, placeholders);
      } else {
        await triggerDispatch(renderedCmd);
      }
    } catch (err) {
      failedCount++;
      results.push({
        repo: repoName,
        path: repoItem.path,
        status: "failed",
        targetCommit,
        durationMs: nowFn() - repoStartTime,
        message: `派发执行异常: ${err.message}`,
      });
      continue;
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
        const currentStatus = await queryRemoteList(options.profile, repoItem.path, execFn);
        if (isRepoCompleted(currentStatus, targetCommit)) {
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
      results.push({
        repo: repoName,
        path: repoItem.path,
        status: "completed",
        targetCommit,
        durationMs,
        message: `检查点已成功推进至 ${targetCommit}`,
      });
    } else {
      failedCount++;
      results.push({
        repo: repoName,
        path: repoItem.path,
        status: "failed",
        targetCommit,
        durationMs,
        message: `等待检查点推进超时 (${options.timeout} 分钟)，未检测到 ${targetCommit}`,
      });
    }
  }

  const totalElapsedMs = nowFn() - startTime;

  const summary = {
    profile: options.profile,
    total: allRepos.length,
    completed: completedCount,
    skipped: skippedCount,
    failed: failedCount,
    totalElapsedMs,
    results,
  };

  const mdReport = generateMarkdownReport(summary);

  let reportSaved = true;
  if (options.reportFile) {
    try {
      fs.writeFileSync(options.reportFile, mdReport, "utf8");
    } catch (err) {
      reportSaved = false;
      console.error(`[WARN] 结算报告写入失败: ${options.reportFile} (${err.message})`);
    }
  }

  return {
    ...summary,
    markdownReport: mdReport,
    reportSaved,
  };
}

/**
 * 命令行可执行入口主逻辑
 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

  if (options.dryRun) {
    console.log("启动流水线预演模式（Dry-Run）...\n");
    const result = await runPipeline(options);
    console.log(`远端扫描完毕：总仓数 ${result.total}，无需更新 ${result.skipped}，待维护 ${result.pending}\n`);
    for (const item of result.dryRunOutput) {
      console.log(`[待执行仓库] ${item.repo} (${item.path})`);
      console.log(`  派发命令: ${item.renderedCommand}\n`);
    }
    return;
  }

  console.log("启动知识维护流水线调度驱动器...\n");

  let lastLineCount = 0;
  const isTty = process.stdout.isTTY;

  const result = await runPipeline(options, {
    onProgress: (stats) => {
      const output = renderDashboard(stats);
      if (isTty) {
        if (lastLineCount > 0) {
          process.stdout.write(`\x1b[${lastLineCount}A\x1b[0J`);
        }
        process.stdout.write(output + "\n");
        lastLineCount = output.split("\n").length;
      } else {
        console.log(`[进度更新] 已完成: ${stats.completed}/${stats.total}, 当前: ${stats.activeRepo}`);
      }
    },
  });

  if (isTty && lastLineCount > 0) {
    process.stdout.write("\n");
  }

  console.log("流水线执行完毕！结算报告如下：\n");
  console.log(result.markdownReport);

  if (options.reportFile) {
    if (result.reportSaved === false) {
      console.log(`结算报告保存失败：${options.reportFile}（详见上方警告）`);
    } else {
      console.log(`结算报告已保存至文件：${options.reportFile}`);
    }
  }

  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

// 当直接作为命令行脚本执行时启动
let isMain = false;
try {
  if (process.argv[1]) {
    const currentFile = fileURLToPath(import.meta.url);
    const scriptFile = path.resolve(process.argv[1]);
    isMain =
      currentFile === scriptFile ||
      (fs.existsSync(scriptFile) && fs.realpathSync(currentFile) === fs.realpathSync(scriptFile));
  }
} catch {
  isMain = false;
}

if (isMain) {
  main().catch((err) => {
    console.error(`流水线执行失败: ${err.message}`);
    process.exit(1);
  });
}
