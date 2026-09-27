import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestRuntime, createTestPlatform, FakeProcessDriver } from "@actiondock/testing";
import pipelineAction from "../actions/pipeline.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("orchestrator.pipeline", () => {
  it("参数校验：未传 dispatchCmd 且非 dryRun 时抛出异常", async () => {
    const runtime = createTestRuntime();

    await assert.rejects(
      () =>
        runtime.run(pipelineAction, {
          profile: "skm",
          dryRun: false,
          dispatchCmd: "",
        }),
      (err: any) => {
        return (
          err.code === "MISSING_DISPATCH_CMD" ||
          /缺少必需参数：.*dispatch-cmd/.test(err.message)
        );
      }
    );
  });

  it("dryRun 预演模式：仅扫描远端变更并渲染派发命令，不实际触发执行", async () => {
    const fakeDriver = new FakeProcessDriver();
    const dispatchedCommands: string[] = [];

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
      ],
    };

    fakeDriver.onSpawn = (handle: any, spec: any) => {
      const cmd = spec.args[1] || spec.args.join(" ");
      if (cmd.includes("maintenance.list")) {
        handle.emitOutput("stdout", JSON.stringify({ ok: true, data: mockScanData }) + "\n");
        handle.emitExit({ code: 0, signal: null });
      } else {
        dispatchedCommands.push(cmd);
        handle.emitExit({ code: 0, signal: null });
      }
      handle.emitOutputClosed("natural");
    };

    const runtime = createTestRuntime({
      platform: createTestPlatform({ processDriver: fakeDriver }),
    });

    const result = await runtime.run(pipelineAction, {
      profile: "skm",
      dryRun: true,
      dispatchCmd: 'ad run my-agent.dispatch --profile skm -- repo="{{repo}}"',
    });

    assert.equal(result.success, true);
    assert.equal(result.total, 2);
    assert.equal(result.skipped, 1);
    assert.equal(result.completed, 0);
    assert.equal(result.failed, 0);
    assert.equal(dispatchedCommands.length, 0); // 预演模式严禁触发实际派发
    assert.equal(result.dryRunResults.length, 1);
    assert.equal(result.dryRunResults[0].repo, "changed-service");
    assert.ok(result.dryRunResults[0].renderedCommand.includes("changed-service"));
    assert.ok(result.report.includes("流水线执行报告"));
  });

  it("两阶段执行与检查点推进闭环：单代码仓与系统知识仓均成功闭环", async () => {
    const fakeDriver = new FakeProcessDriver();
    const dispatchedCommands: string[] = [];

    const mockScanData = {
      batch: true,
      results: [
        {
          repo: "order-service",
          path: "/srv/workspace/order-service",
          branch: "release",
          status: "changed",
          hasChanges: true,
          from: "1111111",
          to: "2222222",
          commitCount: 1,
          commits: [{ hash: "2222222", shortHash: "2222222", message: "feat: payment update" }],
        },
        {
          repo: "system-knowledge",
          path: "/srv/workspace/system-knowledge",
          branch: "master",
          repoType: "system_knowledge",
          status: "upToDate",
          hasChanges: false,
          from: "3333333",
          to: "3333333",
        },
      ],
    };

    fakeDriver.onSpawn = (handle: any, spec: any) => {
      const cmd = spec.args[1] || spec.args.join(" ");

      if (cmd.includes("maintenance.list")) {
        if (!cmd.includes("-- path=")) {
          // 全量初始扫描
          handle.emitOutput("stdout", JSON.stringify({ ok: true, data: mockScanData }) + "\n");
        } else if (cmd.includes("order-service")) {
          // order-service 单仓轮询
          handle.emitOutput(
            "stdout",
            JSON.stringify({
              ok: true,
              data: {
                repo: "order-service",
                from: "2222222",
                to: "2222222",
                hasChanges: false,
                status: "upToDate",
              },
            }) + "\n"
          );
        } else if (cmd.includes("system-knowledge")) {
          // system-knowledge 单仓轮询
          handle.emitOutput(
            "stdout",
            JSON.stringify({
              ok: true,
              data: {
                repo: "system-knowledge",
                from: "3333333",
                to: "3333333",
                hasChanges: false,
                status: "upToDate",
              },
            }) + "\n"
          );
        }
        handle.emitExit({ code: 0, signal: null });
      } else if (cmd.includes("knowledge.list")) {
        handle.emitOutput("stdout", JSON.stringify({ ok: true, data: { items: [] } }) + "\n");
        handle.emitExit({ code: 0, signal: null });
      } else {
        // 派发命令执行
        dispatchedCommands.push(cmd);
        handle.emitExit({ code: 0, signal: null });
      }
      handle.emitOutputClosed("natural");
    };

    const runtime = createTestRuntime({
      platform: createTestPlatform({ processDriver: fakeDriver }),
    });

    const result = await runtime.run(pipelineAction, {
      profile: "skm",
      dryRun: false,
      dispatchCmd: 'ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"',
      timeout: 1,
      interval: 0.001,
    });

    assert.equal(result.success, true);
    assert.equal(result.total, 2);
    assert.equal(result.completed, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].repo, "order-service");
    assert.equal(result.results[0].status, "completed");
    assert.equal(result.results[1].repo, "system-knowledge");
    assert.equal(result.results[1].status, "completed");

    // 验证派发命令发生且第二阶段注入了第一阶段摘要
    assert.equal(dispatchedCommands.length, 2);
    assert.ok(dispatchedCommands[0].includes("order-service"));
    assert.ok(dispatchedCommands[1].includes("system-knowledge"));
    assert.ok(dispatchedCommands[1].includes("前序已完成巡检且发生更新的代码仓"));
  });

  it("报告输出与落盘支持：生成 Markdown 格式报告并成功写入指定文件", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-report-"));
    const reportFile = path.join(tmpDir, "custom-summary.md");

    try {
      const fakeDriver = new FakeProcessDriver();

      const mockScanData = {
        batch: true,
        results: [
          {
            repo: "clean-service",
            path: "/srv/workspace/clean-service",
            branch: "release",
            status: "upToDate",
            hasChanges: false,
            from: "1111111",
            to: "1111111",
          },
        ],
      };

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        handle.emitOutput("stdout", JSON.stringify({ ok: true, data: mockScanData }) + "\n");
        handle.emitExit({ code: 0, signal: null });
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const result = await runtime.run(pipelineAction, {
        profile: "skm",
        dryRun: false,
        dispatchCmd: 'echo "{{repo}}"',
        reportFile,
      });

      assert.equal(result.success, true);
      assert.equal(result.total, 1);
      assert.equal(result.skipped, 1);
      assert.equal(result.reportFile, reportFile);
      assert.ok(result.report.includes("# 知识维护流水线执行报告"));
      assert.ok(result.report.includes("- 跳过无需更新数：1"));

      // 验证文件落盘内容
      assert.ok(fs.existsSync(reportFile));
      const content = fs.readFileSync(reportFile, "utf8");
      assert.ok(content.includes("# 知识维护流水线执行报告"));
      assert.ok(content.includes("clean-service"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("支持实时执行日志追加落盘 (logFile) 供运维 tail 追溯", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipe-log-test-"));
    const logFile = path.join(tmpDir, "pipeline.log");

    const fakeDriver = new FakeProcessDriver();
    fakeDriver.onSpawn = (handle: any, spec: any) => {
      const cmd = spec.args[1] || spec.args.join(" ");
      if (cmd.includes("maintenance.list")) {
        const mockData = {
          batch: true,
          results: [
            {
              repo: "clean-repo",
              path: "/srv/workspace/clean-repo",
              status: "upToDate",
              hasChanges: false,
            },
          ],
        };
        handle.emitOutput("stdout", JSON.stringify({ ok: true, data: mockData }) + "\n");
        handle.emitExit({ code: 0, signal: null });
      } else {
        handle.emitExit({ code: 0, signal: null });
      }
      handle.emitOutputClosed("natural");
    };

    const runtime = createTestRuntime({
      platform: createTestPlatform({ processDriver: fakeDriver }),
    });

    try {
      const result = await runtime.run(pipelineAction, {
        profile: "skm",
        dryRun: false,
        dispatchCmd: "dummy-dispatch",
        logFile,
      });

      assert.equal(result.logFile, logFile);
      assert.ok(fs.existsSync(logFile), "logFile 必须成功创建");
      const logContent = fs.readFileSync(logFile, "utf8");
      assert.match(logContent, /开始执行知识维护流水线/);
      assert.match(logContent, /\[SKIP\] 仓库 clean-repo \(code\) 检查点已对齐/);
      assert.match(logContent, /\[SUMMARY\] 流水线执行完毕/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("服务端物理隔离校验：entrypoint.sh 仅链接三大核心服务包，绝不链接 orchestrator 包", () => {
    const entrypointPath = path.resolve(__dirname, "../../../../server/entrypoint.sh");
    assert.ok(fs.existsSync(entrypointPath), "entrypoint.sh 必须存在");

    const content = fs.readFileSync(entrypointPath, "utf8");

    // 验证链接命令只包含三大服务包
    assert.ok(content.includes("ad link /app/server/packages/knowledge-workspace"));
    assert.ok(content.includes("ad link /app/server/packages/knowledge-inbox"));
    assert.ok(content.includes("ad link /app/server/packages/knowledge-maintenance"));
    assert.ok(!content.includes("knowledge-orchestrator"), "entrypoint.sh 严禁链接 knowledge-orchestrator");

    // 提取 skm 视图配置代码块
    const skmMatch = content.match(/skm:\s*\{[\s\S]*?\n\s*\}/);
    assert.ok(skmMatch, "必须在 entrypoint.sh 中配置 skm 视图");
    const skmConfig = skmMatch[0];

    // skm 视图仅开放 workspace, knowledge, maintenance
    assert.ok(skmConfig.includes('"workspace"'));
    assert.ok(skmConfig.includes('"knowledge"'));
    assert.ok(skmConfig.includes('"maintenance"'));
    assert.ok(!skmConfig.includes("orchestrator"), "skm 视图绝不包含 orchestrator");
  });

  it("三阶段执行与待审池消费闭环：单代码仓、系统知识仓与待审池候选均成功闭环", async () => {
    const fakeDriver = new FakeProcessDriver();
    const dispatchedCommands: string[] = [];

    const mockScanData = {
      batch: true,
      results: [
        {
          repo: "order-service",
          path: "/srv/workspace/order-service",
          branch: "release",
          status: "changed",
          hasChanges: true,
          from: "1111111",
          to: "2222222",
          commitCount: 1,
          commits: [{ hash: "2222222", shortHash: "2222222", message: "feat: update" }],
        },
      ],
    };

    const mockCandidate = {
      id: "20260924-kb1",
      filename: "kb1.md",
      title: "Kafka 排障手册",
      path: "/srv/knowledge-inbox/pending/kb1.md",
      status: "pending",
    };
    let inboxItems = [mockCandidate];

    fakeDriver.onSpawn = (handle: any, spec: any) => {
      const cmd = spec.args[1] || spec.args.join(" ");

      if (cmd.includes("maintenance.list")) {
        if (!cmd.includes("-- path=")) {
          handle.emitOutput("stdout", JSON.stringify({ ok: true, data: mockScanData }) + "\n");
        } else {
          handle.emitOutput(
            "stdout",
            JSON.stringify({
              ok: true,
              data: {
                repo: "order-service",
                from: "2222222",
                to: "2222222",
                hasChanges: false,
                status: "upToDate",
              },
            }) + "\n"
          );
        }
        handle.emitExit({ code: 0, signal: null });
      } else if (cmd.includes("knowledge.list")) {
        handle.emitOutput("stdout", JSON.stringify({ ok: true, data: { items: [...inboxItems] } }) + "\n");
        handle.emitExit({ code: 0, signal: null });
        // 第一次查询返回候选，后续轮询探测时移出
        inboxItems = [];
      } else {
        dispatchedCommands.push(cmd);
        handle.emitExit({ code: 0, signal: null });
      }
      handle.emitOutputClosed("natural");
    };

    const runtime = createTestRuntime({
      platform: createTestPlatform({ processDriver: fakeDriver }),
    });

    const result = await runtime.run(pipelineAction, {
      profile: "skm",
      dryRun: false,
      dispatchCmd: 'dispatch --target="{{candidateId}}{{repo}}"',
      timeout: 1,
      interval: 0.001,
    });

    assert.equal(result.success, true);
    assert.equal(result.total, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.inboxTotal, 1);
    assert.equal(result.inboxCompleted, 1);
    assert.equal(result.inboxFailed, 0);
    assert.equal(result.inboxSkipped, false);
    assert.equal(result.inboxResults.length, 1);
    assert.equal(result.inboxResults[0].id, "20260924-kb1");
    assert.equal(result.inboxResults[0].status, "completed");

    // 验证派发发生
    assert.equal(dispatchedCommands.length, 2);
    assert.ok(dispatchedCommands[0].includes("order-service"));
    assert.ok(dispatchedCommands[1].includes("20260924-kb1"));
  });

  it("skipInbox 参数生效：跳过第三阶段待审池巡检", async () => {
    const fakeDriver = new FakeProcessDriver();
    let knowledgeListQueried = false;

    const mockScanData = {
      batch: true,
      results: [
        {
          repo: "clean-service",
          path: "/srv/workspace/clean-service",
          status: "upToDate",
          hasChanges: false,
        },
      ],
    };

    fakeDriver.onSpawn = (handle: any, spec: any) => {
      const cmd = spec.args[1] || spec.args.join(" ");
      if (cmd.includes("maintenance.list")) {
        handle.emitOutput("stdout", JSON.stringify({ ok: true, data: mockScanData }) + "\n");
        handle.emitExit({ code: 0, signal: null });
      } else if (cmd.includes("knowledge.list")) {
        knowledgeListQueried = true;
        handle.emitExit({ code: 0, signal: null });
      } else {
        handle.emitExit({ code: 0, signal: null });
      }
      handle.emitOutputClosed("natural");
    };

    const runtime = createTestRuntime({
      platform: createTestPlatform({ processDriver: fakeDriver }),
    });

    const result = await runtime.run(pipelineAction, {
      profile: "skm",
      dryRun: false,
      dispatchCmd: 'dispatch --target="{{repo}}"',
      skipInbox: true,
    });

    assert.equal(result.success, true);
    assert.equal(result.inboxSkipped, true);
    assert.equal(result.inboxTotal, 0);
    assert.equal(knowledgeListQueried, false, "开启 skipInbox 时严禁调用 knowledge.list 查询待审池");
  });
});
