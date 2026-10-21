import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTestRuntime, createTestPlatform, FakeProcessDriver } from "@actiondock/testing";
import pipelineAction from "../actions/pipeline.ts";
import {
  runPipeline,
  buildPlaceholders,
  buildInboxPlaceholders,
  buildPrompt,
  renderTemplate,
  isRepoCompleted,
  type PipelineHooks,
  type PipelineOptions,
  type RepoScanItem,
  type DryRunResult,
  type PipelineSummary,
} from "../src/pipeline-core.ts";

const START = 1_000_000;
const COMMIT = "a".repeat(40);
const BACKFILL_SECTION = "## 知识覆盖补齐模式（backfill）";

function repo(name: string, extra: Partial<RepoScanItem> = {}): RepoScanItem {
  return {
    repo: name,
    path: `/srv/workspace/${name}`,
    repoType: "code",
    branch: "release",
    status: "upToDate",
    hasChanges: false,
    from: COMMIT,
    to: COMMIT,
    ...extra,
  };
}

const systemRepo = (extra: Partial<RepoScanItem> = {}) => repo("system-knowledge", {
  repoType: "system_knowledge", branch: "master", ...extra,
});
const inboxRepo = () => repo("knowledge-inbox", { repoType: "inbox", path: "/srv/knowledge-inbox" });
const nameOf = (item: RepoScanItem) => item.repo || path.basename(item.path || "");
const reply = (data: unknown) => ({ stdout: JSON.stringify({ ok: true, data }), stderr: "" });

type Simulation = {
  sync?: (item: RepoScanItem) => Record<string, unknown>;
  poll?: (item: RepoScanItem, count: number, now: number) => Record<string, unknown>;
};

// 所有外部边界均受控；虚拟时钟固定每次轮询耗时，未知命令不予成功兜底。
function harness(items: RepoScanItem[], simulation: Simulation = {}) {
  let now = START;
  const commands: string[] = [];
  const events: string[] = [];
  const dispatched: { command: string; placeholders: Record<string, unknown> }[] = [];
  const polls = new Map<string, number>();
  const hooks: PipelineHooks = {
    nowFn: () => now,
    sleepFn: async (ms) => { now += ms; },
    dispatchFn: async (command, placeholders: Record<string, unknown> = {}) => {
      dispatched.push({ command, placeholders });
      events.push(`dispatch:${placeholders.repo}`);
    },
    execFn: async (command) => {
      commands.push(command);
      if (command.startsWith("ad run maintenance.list ") && !command.includes("-- path=")) {
        events.push("scan");
        return reply({ batch: true, results: items });
      }
      const repoPath = command.match(/-- path="([^"]+)"/)?.[1];
      const item = items.find((entry) => entry.path === repoPath);
      if (command.startsWith("ad run maintenance.sync ") && item) {
        events.push(`sync:${nameOf(item)}`);
        return reply(simulation.sync?.(item) ?? { status: "success", currentCommit: item.to });
      }
      if (command.startsWith("ad run maintenance.list ") && item) {
        const name = nameOf(item);
        const count = (polls.get(name) ?? 0) + 1;
        polls.set(name, count);
        events.push(`poll:${name}`);
        return reply(simulation.poll?.(item, count, now) ?? {
          ...item, checkpointUpdatedAt: new Date(now).toISOString(),
        });
      }
      if (command.startsWith("ad run workspace/bash.exec ") && command.includes("git merge --abort")) {
        events.push("abort");
        return reply({});
      }
      throw new Error(`测试中出现未预期命令：${command}`);
    },
  };
  return {
    commands, events, dispatched, polls, hooks,
    run: (options: PipelineOptions = {}) => runPipeline({
      mode: "backfill",
      dispatchCmd: "dispatch {{mode}} {{repo}}",
      interval: 0.01,
      timeout: 0.001,
      skipInbox: false,
      ...options,
    }, hooks),
  };
}

function assertNoInboxOrCompletion(commands: string[]) {
  assert.equal(commands.some((cmd) => /ad run (?:knowledge\.|maintenance\.(?:publish|complete)\b)/.test(cmd)), false);
  assert.equal(commands.some((cmd) => cmd.includes("/srv/knowledge-inbox")), false);
}

test("backfill：预演与正式运行复用精确范围，无变更仍同步派发且强制跳过 Inbox", async (t) => {
  const cases: { title: string; options: PipelineOptions; names: string[] }[] = [
    { title: "省略 only 为全部代码仓和系统仓", options: {}, names: ["order-service", "order-service-worker", "legacy-service", "system-knowledge"] },
    { title: "only 精确限定代码仓但自动联动系统仓", options: { only: "  ORDER-Service \t" }, names: ["order-service", "system-knowledge"] },
    { title: "only 单仓显式关闭系统联动", options: { only: "order-service", skipSystemKnowledge: true }, names: ["order-service"] },
    { title: "only 系统仓仍执行全景补齐", options: { only: "system-knowledge" }, names: ["system-knowledge"] },
    { title: "多仓逗号分隔、去重，系统仓保持最后执行", options: { only: " SYSTEM-KNOWLEDGE, Order-Service, order-service " }, names: ["order-service", "system-knowledge"] },
    { title: "缺少 repo 时复用路径 basename 并联动系统仓", options: { only: " LEGACY-SERVICE " }, names: ["legacy-service", "system-knowledge"] },
    { title: "无显式系统目标时可排除系统仓", options: { skipSystemKnowledge: true }, names: ["order-service", "order-service-worker", "legacy-service"] },
  ];
  for (const { title, options, names } of cases) {
    await t.test(title, async () => {
      const items = [systemRepo(), inboxRepo(), repo("order-service"), repo("order-service-worker"), {
        path: "/srv/workspace/legacy-service", status: "upToDate", hasChanges: false, from: COMMIT, to: COMMIT,
      }];
      const dry = harness(items);
      const preview = await dry.run({ ...options, dryRun: true }) as DryRunResult;
      assert.equal(preview.mode, "backfill");
      assert.equal(preview.total, names.length);
      assert.equal(preview.pending, names.length);
      assert.equal(preview.skipped, 0);
      assert.equal(preview.failed, 0);
      assert.deepEqual(preview.dryRunOutput.map((item) => item.repo), names);
      assert.equal(dry.dispatched.length, 0);
      assert.equal(dry.commands.length, 1);
      assert.match(dry.commands[0]!, /maintenance\.list .*fetch:=true/);
      for (const item of preview.dryRunOutput) {
        assert.equal(item.placeholders.mode, "backfill");
        assert.equal(item.renderedCommand, `dispatch backfill ${item.repo}`);
        const related = item.repoType === "system_knowledge" && names.some((name) => name !== "system-knowledge");
        assert.equal(item.placeholders.prompt.includes(BACKFILL_SECTION), !related);
        if (item.repoType === "system_knowledge") {
          assert.equal(item.placeholders.systemScope, related ? "related" : "full");
          assert.match(item.placeholders.prompt, related ? /系统知识库定向聚合任务指导/ : /系统知识库覆盖补齐任务指导/);
        }
      }

      const live = harness(items);
      const result = await live.run(options) as PipelineSummary;
      assert.equal(result.mode, "backfill");
      assert.equal(result.total, names.length);
      assert.equal(result.completed, preview.pending);
      assert.equal(result.skipped, 0);
      assert.equal(result.failed, 0);
      assert.equal(result.success, true);
      assert.deepEqual(result.results.map((item) => item.repo), names);
      assert.deepEqual(live.dispatched.map((item) => item.command), preview.dryRunOutput.map((item) => item.renderedCommand));
      assert.deepEqual(live.events.filter((event) => event.startsWith("sync:")), names.map((name) => `sync:${name}`));
      for (const name of names) {
        assert.ok(live.events.indexOf(`sync:${name}`) < live.events.indexOf(`dispatch:${name}`));
        assert.equal(live.polls.get(name), 1);
      }
      for (const outcome of [preview, result]) {
        assert.equal(outcome.inboxSkipped, true);
        assert.equal(outcome.inboxTotal, 0);
        assert.equal(outcome.inboxCompleted, 0);
        assert.equal(outcome.inboxFailed, 0);
        assert.deepEqual(outcome.inboxResults, []);
      }
      assertNoInboxOrCompletion(live.commands);
      assert.match(result.markdownReport, /维护模式：知识覆盖补齐/);
    });
  }
});

test("backfill：非法或不可执行的范围在任何同步、派发之前失败", async (t) => {
  const cases: { title: string; options: PipelineOptions; items?: RepoScanItem[] }[] = [
    { title: "空串", options: { only: "" } },
    { title: "空白", options: { only: " \t " } },
    { title: "只有分隔符", options: { only: " , , " } },
    { title: "不接受部分名称", options: { only: "order" } },
    { title: "未知仓库", options: { only: "missing" } },
    { title: "已知与未知混合不能部分执行", options: { only: "order-service, MISSING" } },
    { title: "仅 Inbox", options: { only: "knowledge-inbox" } },
    { title: "代码仓与 Inbox 混合", options: { only: "order-service,knowledge-inbox" } },
    { title: "显式系统仓被跳过", options: { only: "system-knowledge", skipSystemKnowledge: true } },
    { title: "混合范围中的系统仓被跳过", options: { only: "order-service,system-knowledge", skipSystemKnowledge: true } },
    { title: "全部范围为空", options: {}, items: [] },
    { title: "全部范围只有 Inbox", options: {}, items: [inboxRepo()] },
  ];
  for (const { title, options, items } of cases) {
    await t.test(title, async () => {
      for (const dryRun of [true, false]) {
        const h = harness(items ?? [repo("order-service"), systemRepo(), inboxRepo()]);
        await assert.rejects(h.run({ ...options, dryRun }), /补齐.*(?:only 不能为空|未匹配或不可处理|没有可处理)/);
        assert.equal(h.commands.length, 1);
        assert.deepEqual(h.events, ["scan"]);
        assert.equal(h.dispatched.length, 0);
      }
    });
  }
});

test("backfill：系统仓无变更或自身有变更都必须先同步再交给 AI，不能仅 complete", async (t) => {
  for (const hasChanges of [false, true]) {
    await t.test(hasChanges ? "自身有变更" : "检查点已对齐", async () => {
      const h = harness([systemRepo({ hasChanges, status: hasChanges ? "changed" : "upToDate" })], {
        sync: () => ({ status: "success", currentCommit: "synced-head" }),
        poll: (_item, _count, now) => ({
          status: "upToDate", hasChanges: false,
          from: "published-head", to: "published-head",
          checkpointUpdatedAt: new Date(now).toISOString(),
        }),
      });
      const result = await h.run() as PipelineSummary;
      assert.equal(result.completed, 1);
      assert.equal(result.failed, 0);
      assert.equal(result.skipped, 0);
      assert.deepEqual(h.events, ["scan", "sync:system-knowledge", "dispatch:system-knowledge", "poll:system-knowledge"]);
      assert.equal(h.dispatched[0]!.placeholders.to, "synced-head");
      assert.equal(h.dispatched[0]!.placeholders.mode, "backfill");
      assert.equal(h.dispatched[0]!.placeholders.systemScope, "full");
      assert.ok(String(h.dispatched[0]!.placeholders.prompt).includes(BACKFILL_SECTION));
      assert.match(String(h.dispatched[0]!.placeholders.prompt), /系统知识库覆盖补齐任务指导/);
      assert.equal(result.results[0]!.targetCommit, "synced-head");
      assertNoInboxOrCompletion(h.commands);
    });
  }
});

test("backfill：扫描或同步失败不能因旧 commit 对齐而强制放行", async (t) => {
  for (const kind of ["code", "system"] as const) {
    const makeRepo = (extra: Partial<RepoScanItem> = {}) => kind === "code" ? repo("order-service", extra) : systemRepo(extra);
    await t.test(`${kind} 扫描错误`, async () => {
      for (const dryRun of [true, false]) {
        const h = harness([makeRepo({ status: "error", message: "scan denied" })]);
        const result = await h.run({ dryRun, skipSystemKnowledge: kind === "code" });
        assert.equal(result.total, 1);
        assert.equal(result.skipped, 0);
        if (result.dryRun) {
          assert.equal(result.failed, 1);
          assert.equal(result.pending, 0);
          assert.deepEqual(result.dryRunOutput, []);
        } else {
          assert.equal(result.failed, 1);
          assert.equal(result.success, false);
          assert.match(result.results[0]!.message, /扫描失败.*scan denied/);
        }
        assert.deepEqual(h.events, ["scan"]);
      }
    });
    for (const status of ["error", "dirty_worktree", ...(kind === "system" ? ["conflict"] : []), "throw"]) {
      await t.test(`${kind} 同步 ${status}`, async () => {
        const h = harness([makeRepo()], {
          sync: () => {
            if (status === "throw") throw new Error("sync unavailable");
            return { status, message: "sync denied", currentCommit: COMMIT, conflictFiles: ["docs/knowledge/index.md"] };
          },
        });
        const result = await h.run({ skipSystemKnowledge: kind === "code" }) as PipelineSummary;
        assert.equal(result.completed, 0);
        assert.equal(result.skipped, 0);
        assert.equal(result.failed, 1);
        assert.equal(result.success, false);
        assert.match(result.results[0]!.message, /同步|工作区/);
        assert.deepEqual(h.events, ["scan", `sync:${nameOf(makeRepo())}`]);
        assert.equal(h.dispatched.length, 0);
        assert.equal(h.polls.size, 0);
        assertNoInboxOrCompletion(h.commands);
      });
    }
  }
  await t.test("全量扫描请求失败直接传播", async () => {
    const h = harness([repo("order-service")]);
    await assert.rejects(runPipeline({ mode: "backfill", dispatchCmd: "dispatch" }, {
      ...h.hooks,
      execFn: async () => { throw new Error("scan transport failed"); },
    }), /scan transport failed/);
    assert.equal(h.dispatched.length, 0);
  });
});

test("isRepoCompleted：补齐必须有派发后合法完成时间，不得回退到同 commit", () => {
  const aligned = { status: "upToDate", hasChanges: false, from: COMMIT, to: COMMIT };
  const options = { dispatchedAt: START, requireFreshCheckpoint: true };
  for (const checkpointUpdatedAt of [undefined, null, "", "not-a-date", "2026-99-99T99:99:99Z", new Date(START - 1).toISOString()]) {
    assert.equal(isRepoCompleted({ ...aligned, checkpointUpdatedAt }, COMMIT, options), false, String(checkpointUpdatedAt));
  }
  for (const time of [START, START + 1]) {
    const fresh = { ...aligned, checkpointUpdatedAt: new Date(time).toISOString() };
    assert.equal(isRepoCompleted(fresh, COMMIT, options), true);
    assert.equal(isRepoCompleted({ ok: true, data: fresh }, COMMIT, options), true);
    assert.equal(isRepoCompleted({ ...fresh, status: "error" }, COMMIT, options), false);
    assert.equal(isRepoCompleted({ ...fresh, from: "new-published-commit", to: "new-published-commit" }, COMMIT, options), true);
  }
  assert.equal(isRepoCompleted(aligned, COMMIT, { requireFreshCheckpoint: true }), false);
  assert.equal(isRepoCompleted(aligned, COMMIT, { ...options, dispatchedAt: NaN }), false);
  assert.equal(isRepoCompleted(aligned, COMMIT, { dispatchedAt: START }), true);
  assert.equal(isRepoCompleted(aligned, COMMIT), true);
});

test("backfill dispatcher：旧相同 commit 轮询多次后，仅新时间能完成；一直无时间则超时", async () => {
  const h = harness([repo("order-service")], {
    poll: (item, count, now) => ({
      ...item,
      ...(count === 1 ? { checkpointUpdatedAt: new Date(START - 1).toISOString() }
        : count === 2 ? {}
        : { checkpointUpdatedAt: count === 3 ? "invalid" : new Date(now).toISOString() }),
    }),
  });
  const result = await h.run({ skipSystemKnowledge: true }) as PipelineSummary;
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.equal(h.polls.get("order-service"), 4);
  assert.equal(result.results[0]!.durationMs, 40);
  assert.equal(h.dispatched.length, 1);

  const stalled = harness([repo("order-service")], { poll: (item) => ({ ...item }) });
  const timeout = await stalled.run({ skipSystemKnowledge: true }) as PipelineSummary;
  assert.equal(timeout.completed, 0);
  assert.equal(timeout.failed, 1);
  assert.equal(timeout.success, false);
  assert.equal(stalled.polls.get("order-service"), 5);
  assert.equal(timeout.results[0]!.durationMs, 60);
  assert.match(timeout.results[0]!.message, /超时/);
});

test("incremental：默认与显式增量保持跳过行为，dispatcher 不强制新时间", async (t) => {
  for (const explicit of [false, true]) {
    await t.test(explicit ? "显式增量" : "默认增量", async () => {
      const options = explicit ? { mode: "incremental" as const } : {};
      const clean = harness([repo("order-service"), systemRepo()]);
      const skipped = await runPipeline({ dispatchCmd: "dispatch", skipInbox: true, ...options }, clean.hooks) as PipelineSummary;
      assert.equal(skipped.mode, "incremental");
      assert.equal(skipped.skipped, 2);
      assert.equal(skipped.completed, 0);
      assert.deepEqual(clean.events, ["scan"]);

      const changed = harness([repo("order-service", { status: "changed", hasChanges: true })], {
        poll: () => ({ from: COMMIT, to: COMMIT, status: "upToDate", hasChanges: false }),
      });
      const result = await runPipeline({
        dispatchCmd: "dispatch {{mode}} {{repo}}", interval: 0.01, timeout: 0.001, skipInbox: true, ...options,
      }, changed.hooks) as PipelineSummary;
      assert.equal(result.completed, 1);
      assert.equal(result.failed, 0);
      assert.equal(changed.polls.get("order-service"), 1);
      assert.equal(changed.dispatched[0]!.command, "dispatch incremental order-service");
      assert.ok(!String(changed.dispatched[0]!.placeholders.prompt).includes(BACKFILL_SECTION));
    });
  }
});

test("backfill：代码仓保留冲突消解流程，成功后继续补齐，失败仍清理合并", async (t) => {
  for (const finishes of [true, false]) {
    await t.test(finishes ? "消解并补齐成功" : "补齐未完成超时回滚", async () => {
      const h = harness([repo("order-service")], {
        sync: () => ({ status: "conflict", knowledgeBranch: "knowledge", conflictFiles: ["docs/knowledge/flow/flow-order.md"] }),
        poll: (item, _count, now) => ({ ...item, ...(finishes ? { checkpointUpdatedAt: new Date(now).toISOString() } : {}) }),
      });
      const result = await h.run({ skipSystemKnowledge: true }) as PipelineSummary;
      assert.equal(result.completed, finishes ? 1 : 0);
      assert.equal(result.failed, finishes ? 0 : 1);
      assert.equal(h.dispatched.length, 1);
      assert.match(h.commands.find((cmd) => cmd.includes("maintenance.sync"))!, /preserveConflict:=true/);
      const placeholders = h.dispatched[0]!.placeholders;
      assert.equal(placeholders.isConflict, true);
      assert.equal(placeholders.knowledgeBranch, "knowledge");
      assert.deepEqual(placeholders.conflictFiles, ["docs/knowledge/flow/flow-order.md"]);
      const prompt = String(placeholders.prompt);
      assert.match(prompt, /知识维护单仓冲突消解任务指导/);
      assert.match(prompt, /冲突消解只是前置步骤，继续执行下方的知识覆盖补齐任务/);
      assert.match(prompt, /不得调用 maintenance\.complete 提前结束/);
      assert.ok(prompt.includes(BACKFILL_SECTION));
      assert.ok(!prompt.includes("conflict_resolved"));
      assert.equal(h.events.includes("abort"), !finishes);
      assertNoInboxOrCompletion(h.commands);
    });
  }
});

test("backfill 提示词与占位符：源码发现优先于无变更及已有 scope，限定写入并验收覆盖", async (t) => {
  for (const item of [repo("order-service"), systemRepo()]) {
    await t.test(nameOf(item), () => {
      const placeholders = buildPlaceholders(item, { mode: "backfill" });
      assert.equal(placeholders.mode, "backfill");
      const prompt = placeholders.prompt as string;
      assert.equal(buildPrompt(placeholders), prompt);
      assert.equal(renderTemplate("{{mode}}\n{{prompt}}", placeholders, { escapeQuotes: false }), `backfill\n${prompt}`);
      for (const required of [
        BACKFILL_SECTION,
        "本节优先于技能中的无变更跳过与已有文档 scope 门槛",
        "即使 from 与 to 相同、没有新增提交或六类目录已存在，也必须执行源码覆盖调查",
        "git diff 和已有文档只能提供线索，不能限定发现范围",
        "入口装配、注册表、公共导出、路由、CLI/工具动作、消息消费者、回调和定时任务",
        "结合测试、状态读写、配置、日志和错误码反查遗漏",
        "不能因为主题没有现存 scope 或引用就略过",
        "主题覆盖表：主题、真实入口线索、对应文档或小节、调查状态与缺口",
        "从源码入口清单反向核对覆盖",
        "其他仓库只能只读核验",
        "不得因跨仓关联擅自修改、发布或推进其他仓库检查点",
        "只有完成上述源码调查、确认没有可补内容后才可使用 no_change_needed",
        "即使提交哈希没有变化，也必须生成本次新的完成记录",
        "links.verify",
      ]) assert.ok(prompt.includes(required), `缺少约束：${required}`);
      const gate = item.repoType === "system_knowledge" ? "## 第一阶段：全景事实探索与自主推导决策" : "## 全自动自闭环与更新判定门禁";
      assert.ok(prompt.indexOf(BACKFILL_SECTION) < prompt.indexOf(gate));
      if (item.repoType === "system_knowledge") {
        assert.ok(prompt.includes(`仅写入目标系统知识仓 ${item.path} 的知识文档与索引`));
      } else {
        assert.ok(prompt.includes(`仅写入目标仓库 ${item.path}/docs/knowledge/`));
        assert.match(prompt, /四问只用于核对已写知识；还需独立调查未文档化主题/);
        assert.doesNotMatch(prompt, /若存量骨架完备且四问均为“否”/);
      }
      assert.doesNotMatch(prompt, /actionTaken="conflict_resolved"/);
      const incremental = buildPlaceholders(item);
      assert.equal(incremental.mode, "incremental");
      assert.ok(!incremental.prompt.includes(BACKFILL_SECTION));
      assert.ok(!buildPrompt({ ...placeholders, mode: "incremental" }).includes(BACKFILL_SECTION));
    });
  }
  const conflict = buildPrompt({ ...buildPlaceholders(repo("order-service")), isConflict: true });
  assert.match(conflict, /actionTaken="conflict_resolved"/);
  assert.ok(!conflict.includes(BACKFILL_SECTION));
  const inbox = buildInboxPlaceholders({ id: "candidate", filename: "candidate.md" });
  assert.equal(inbox.mode, "incremental");
  assert.equal(renderTemplate("dispatch {{mode}} {{candidateId}}", inbox), "dispatch incremental candidate");
  assert.ok(!inbox.prompt.includes(BACKFILL_SECTION));
});

test("Action dryRun：FakeProcessDriver 验证 mode、报告及扫描错误透传", async (t) => {
  for (const scanError of [false, true]) {
    await t.test(scanError ? "错误仓不派发且预演报告失败" : "无变更仓也纳入补齐", async () => {
      const driver = new FakeProcessDriver();
      const commands: string[] = [];
      const code = repo("order-service", scanError ? { status: "error", message: "scan denied" } : {});
      driver.onSpawn = (handle, spec) => {
        assert.equal(spec.executable, "sh");
        assert.equal(spec.args?.[0], "-c");
        const command = spec.args?.[1] || "";
        commands.push(command);
        assert.match(command, /^ad run maintenance\.list .*fetch:=true/);
        assert.ok(!command.includes("-- path="));
        driver.emitOutput(handle, "stdout", reply({ batch: true, results: [systemRepo(), code, inboxRepo()] }).stdout);
        driver.emitExit(handle, { code: 0, signal: null });
        driver.emitOutputClosed(handle, "natural");
      };
      const runtime = createTestRuntime({ platform: createTestPlatform({ processDriver: driver }) });
      const result = await runtime.run(pipelineAction, {
        mode: "backfill", dryRun: true, skipInbox: false,
        dispatchCmd: "dispatch {{mode}} {{repo}}",
      });
      const names = scanError ? [] : ["order-service", "system-knowledge"];
      assert.equal(result.mode, "backfill");
      assert.equal(result.success, !scanError);
      assert.equal(result.total, 2);
      assert.equal(result.skipped, scanError ? 1 : 0);
      assert.equal(result.completed, 0);
      assert.equal(result.failed, scanError ? 1 : 0);
      assert.deepEqual(result.dryRunResults.map((item) => item.repo), names);
      assert.deepEqual(result.dryRunResults.map((item) => item.renderedCommand), names.map((name) => `dispatch backfill ${name}`));
      for (const item of result.dryRunResults) {
        assert.ok(item.placeholders);
        assert.equal(item.placeholders.mode, "backfill");
        const related = item.repoType === "system_knowledge";
        assert.equal(String(item.placeholders.prompt).includes(BACKFILL_SECTION), !related);
        if (related) {
          assert.equal(item.placeholders.systemScope, "related");
          assert.match(String(item.placeholders.prompt), /系统知识库定向聚合任务指导/);
        }
      }
      assert.equal(result.inboxSkipped, true);
      assert.equal(result.inboxTotal, 0);
      assert.deepEqual(result.inboxResults, []);
      assert.match(result.report, /维护模式：知识覆盖补齐/);
      assert.match(result.report, /待审池状态：已跳过/);
      assert.ok(result.report.includes(`失败或超时数：${scanError ? 1 : 0}`));
      assert.equal(result.reportFile, null);
      assert.equal(driver.spawnCalls.length, 1);
      assert.equal(commands.length, 1);
    });
  }
});
