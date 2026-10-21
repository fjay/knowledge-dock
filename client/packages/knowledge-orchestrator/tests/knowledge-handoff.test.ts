import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRuntime, createTestPlatform, FakeProcessDriver } from "@actiondock/testing";
import pipelineAction from "../actions/pipeline.ts";
import {
  runPipeline, buildPlaceholders,
  type PipelineHooks, type PipelineOptions, type PipelineSummary, type DryRunResult,
  type RepoScanItem, type RepoResult, type KnowledgeChange,
} from "../src/pipeline-core.ts";

const START = 1_000_000;
const COMMIT = "a".repeat(40);
const BACKFILL_SECTION = "## 知识覆盖补齐模式（backfill）";
const OLD = {
  actionTaken: "historical_action",
  checkpointSummary: "历史主题不可冒充本次交接",
  knowledgeChanges: [{ path: "docs/knowledge/flow/flow-historical.md", summary: "历史文档清单" }],
};
const CURRENT = {
  actionTaken: "docs_updated",
  checkpointSummary: "订单失败恢复、支付事件契约与公共幂等规则",
  knowledgeChanges: [
    { path: "docs/knowledge/flow/flow-order-recovery.md", summary: "新增订单失败恢复及下游状态交接" },
    { path: "docs/knowledge/interface/interface-payment-events.md", summary: "修改支付事件载荷和关联键" },
    { path: "docs/knowledge/rule/rule-obsolete-retry.md", summary: "删除失效重试规则并清理索引" },
  ],
};
const reply = (data: unknown) => ({ stdout: JSON.stringify({ ok: true, data }), stderr: "" });
function repo(name: string, extra: Partial<RepoScanItem> = {}): RepoScanItem {
  return {
    repo: name, path: `/srv/workspace/${name}`, repoType: "code", branch: "release",
    status: "upToDate", hasChanges: false, from: COMMIT, to: COMMIT, ...extra,
  };
}
const system = (name = "system-knowledge", extra: Partial<RepoScanItem> = {}) => repo(name, {
  repoType: "system_knowledge", branch: "master", ...extra,
});
const aligned = () => ({ status: "upToDate", hasChanges: false, from: COMMIT, to: COMMIT });
const metadata = (value: Partial<RepoResult>) => Object.fromEntries(
  ["actionTaken", "checkpointSummary", "knowledgeChanges"]
    .filter((key) => Object.hasOwn(value, key))
    .map((key) => [key, value[key as keyof RepoResult]]),
);
function assertNoHistory(text: string) {
  for (const value of [OLD.actionTaken, OLD.checkpointSummary, OLD.knowledgeChanges[0]!.path, OLD.knowledgeChanges[0]!.summary]) {
    assert.ok(!text.includes(value), `不得注入历史交接：${value}`);
  }
}
function assertRelated(placeholders: Record<string, any>) {
  assert.equal(placeholders.systemScope, "related");
  assert.match(placeholders.prompt, /^# 系统知识库定向聚合任务指导/);
  assert.ok(!placeholders.prompt.includes(BACKFILL_SECTION));
  assert.doesNotMatch(placeholders.prompt, /## 第一阶段：全景事实探索与自主推导决策|业务领域识别与目录初始化三步法/);
  for (const boundary of [
    "仅围绕下面本次成功任务的文档变更、主题及必要跨仓交接",
    "逐篇阅读代码仓的新建或修改文档", "删除项核对其提交与索引",
    "摘要只是核验线索，不能代替证据", "不重新扫描全部工作区",
    "不主动全景补齐无关领域", "不把未执行或失败的代码仓当作已完成知识更新",
    "明确空清单则尊重该仓本次无文档改动的结论",
  ]) assert.ok(placeholders.prompt.includes(boundary), boundary);
}

type Simulation = {
  sync?: (item: RepoScanItem) => Record<string, unknown>;
  poll?: (item: RepoScanItem, count: number, now: number) => Record<string, unknown>;
  dispatch?: (placeholders: Record<string, any>) => void;
};
// 全部命令均由 hooks 接管；即使实现吞下边界错误，也会在运行结束时检查未知命令。
function harness(items: RepoScanItem[], simulation: Simulation = {}) {
  let now = START;
  const commands: string[] = [];
  const unexpected: string[] = [];
  const logs: string[] = [];
  const events: string[] = [];
  const polls = new Map<string, number>();
  const dispatched: Record<string, any>[] = [];
  const hooks: PipelineHooks = {
    nowFn: () => now,
    logFn: (message) => { logs.push(message); },
    sleepFn: async (ms) => { now += ms; },
    dispatchFn: async (_command, placeholders) => {
      dispatched.push(placeholders);
      events.push(`dispatch:${placeholders.repo}`);
      simulation.dispatch?.(placeholders);
    },
    execFn: async (command) => {
      commands.push(command);
      if (command.startsWith("ad run maintenance.list ") && !command.includes("-- path=")) {
        events.push("scan");
        return reply({ batch: true, results: items });
      }
      const repoPath = command.match(/-- path="([^"]+)"/)?.[1];
      const item = items.find((entry) => entry.path === repoPath);
      if (item && command.startsWith("ad run maintenance.sync ")) {
        events.push(`sync:${item.repo}`);
        return reply(simulation.sync?.(item) ?? { status: "success", currentCommit: COMMIT });
      }
      if (item && command.startsWith("ad run maintenance.list ")) {
        const name = item.repo!;
        const count = (polls.get(name) ?? 0) + 1;
        polls.set(name, count);
        events.push(`poll:${name}`);
        return reply(simulation.poll?.(item, count, now) ?? {
          ...aligned(), checkpointUpdatedAt: new Date(now).toISOString(),
        });
      }
      unexpected.push(command);
      throw new Error(`未预期的外部命令：${command}`);
    },
  };
  return {
    commands, events, dispatched, polls, hooks, logs,
    advance: (ms: number) => { now += ms; },
    run: async (options: PipelineOptions = {}) => {
      try {
        return await runPipeline({
          mode: "backfill", dispatchCmd: "dispatch {{repo}}", interval: 0.01,
          timeout: 0.001, skipInbox: false, ...options,
        }, hooks);
      } finally {
        assert.deepEqual(unexpected, []);
      }
    },
  };
}

test("定向聚合：only 代码仓自动纳入完整扫描中的全部系统仓，不补同名前缀或其他代码仓", async () => {
  const items = [
    system("system-knowledge-payments"), repo("order-service-worker"),
    repo("order-service", { ...OLD }), system(), repo("unrelated-service"),
    repo("knowledge-inbox", { repoType: "inbox", path: "/srv/knowledge-inbox" }),
  ];
  const h = harness(items, {
    poll: (item, _count, now) => ({
      ...aligned(), checkpointUpdatedAt: new Date(now).toISOString(),
      ...(item.repoType === "code" ? CURRENT : {}),
    }),
  });
  const result = await h.run({ only: " ORDER-SERVICE " }) as PipelineSummary;
  assert.equal(result.total, 3);
  assert.equal(result.completed, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.success, true);
  assert.deepEqual(h.dispatched.map((item) => item.repo), ["order-service", "system-knowledge-payments", "system-knowledge"]);
  assert.deepEqual(h.events, [
    "scan", "sync:order-service", "dispatch:order-service", "poll:order-service",
    "sync:system-knowledge-payments", "dispatch:system-knowledge-payments", "poll:system-knowledge-payments",
    "sync:system-knowledge", "dispatch:system-knowledge", "poll:system-knowledge",
  ]);
  assert.deepEqual(metadata(result.results[0]!), CURRENT);
  assert.ok(String(h.dispatched[0]!.prompt).includes(BACKFILL_SECTION));
  for (const placeholders of h.dispatched.slice(1)) {
    assertRelated(placeholders);
    assert.ok(placeholders.prompt.includes(placeholders.codePhaseSummary));
    const summary = String(placeholders.codePhaseSummary);
    for (const required of [
      "共 1 个，仅包含本次成功任务", "路径：/srv/workspace/order-service",
      "知识目录：/srv/workspace/order-service/docs/knowledge/", CURRENT.actionTaken, CURRENT.checkpointSummary,
      ...CURRENT.knowledgeChanges.map((change) => `${change.path}：${change.summary}`),
    ]) assert.ok(summary.includes(required), required);
    assertNoHistory(placeholders.prompt);
    assert.doesNotMatch(summary, /order-service-worker|unrelated-service/);
  }
  assert.equal(result.inboxSkipped, true);
  assert.deepEqual(result.inboxResults, []);
});

test("补齐联动：未配置受管系统仓时 fail-fast，必须显式关闭才能独立单仓运行", async (t) => {
  for (const dryRun of [true, false]) {
    for (const only of [undefined, "order-service"]) {
      await t.test(`${dryRun ? "预演" : "实际"} ${only ?? "全部"}`, async () => {
        const h = harness([repo("order-service")]);
        await assert.rejects(h.run({ dryRun, ...(only ? { only } : {}) }), /未发现受管系统知识仓.*显式设置 skipSystemKnowledge=true/);
        assert.deepEqual(h.events, ["scan"]);
        assert.equal(h.commands.length, 1);
        const standalone = await h.run({ dryRun, only: "order-service", skipSystemKnowledge: true });
        assert.equal(standalone.total, 1);
        assert.equal(standalone.failed, 0);
        if (standalone.dryRun) assert.equal(standalone.pending, 1);
        else assert.equal(standalone.completed, 1);
        assert.equal(standalone.inboxSkipped, true);
      });
    }
  }
});

test("定向聚合：部分成功仅交接成功仓，全部失败跳过系统聚合，即便系统自身有变化或开启 force", async (t) => {
  for (const hasSuccess of [true, false]) {
    await t.test(hasSuccess ? "部分成功" : "全部失败", async () => {
      const items = [
        system("system-knowledge", { status: "changed", hasChanges: true }),
        ...(hasSuccess ? [repo("successful-service")] : []),
        repo("scan-failed", { status: "error", message: "scan denied", ...OLD }),
        repo("sync-failed", { ...OLD }), repo("dispatch-failed", { ...OLD }), repo("timeout-failed", { ...OLD }),
      ];
      const h = harness(items, {
        sync: (item) => ({ status: item.repo === "sync-failed" ? "error" : "success", message: "sync denied" }),
        dispatch: (placeholders) => { if (placeholders.repo === "dispatch-failed") throw new Error("dispatch denied"); },
        poll: (item, _count, now) => item.repo === "timeout-failed"
          ? { ...aligned(), checkpointUpdatedAt: new Date(START - 1).toISOString(), ...OLD }
          : { ...aligned(), checkpointUpdatedAt: new Date(now).toISOString(), ...(item.repoType === "code" ? CURRENT : {}) },
      });
      const result = await h.run({ forceSystemKnowledge: true, syncSystemKnowledge: true }) as PipelineSummary;
      assert.equal(result.total, hasSuccess ? 6 : 5);
      assert.equal(result.completed, hasSuccess ? 2 : 0);
      assert.equal(result.failed, 4);
      assert.equal(result.skipped, hasSuccess ? 0 : 1);
      assert.equal(result.success, false);
      for (const name of ["scan-failed", "sync-failed", "dispatch-failed", "timeout-failed"]) {
        const failed = result.results.find((item) => item.repo === name)!;
        assert.equal(failed.status, "failed");
        assert.deepEqual(metadata(failed), {});
      }
      assert.match(result.results.find((item) => item.repo === "scan-failed")!.message, /扫描失败/);
      assert.match(result.results.find((item) => item.repo === "sync-failed")!.message, /同步/);
      assert.match(result.results.find((item) => item.repo === "dispatch-failed")!.message, /派发执行异常/);
      assert.match(result.results.find((item) => item.repo === "timeout-failed")!.message, /超时/);
      const sys = h.dispatched.find((item) => item.repoType === "system_knowledge");
      if (hasSuccess) {
        assert.ok(sys);
        assertRelated(sys);
        assert.match(sys.codePhaseSummary, /共 1 个，仅包含本次成功任务/);
        assert.match(sys.codePhaseSummary, /仓库：successful-service/);
        assert.doesNotMatch(sys.codePhaseSummary, /scan-failed|sync-failed|dispatch-failed|timeout-failed/);
        assertNoHistory(sys.prompt);
        assert.ok(h.events.indexOf("poll:timeout-failed") < h.events.indexOf("sync:system-knowledge"));
      } else {
        assert.equal(sys, undefined);
        assert.ok(!h.events.includes("sync:system-knowledge"));
        assert.equal(result.results.at(-1)!.status, "skipped");
        assert.match(result.results.at(-1)!.message, /没有成功完成补齐的代码仓.*不将失败仓视为已更新/);
      }
      assert.equal(result.inboxSkipped, true);
    });
  }
});

test("定向聚合：明确 actionTaken=skipped 的完成记录保留结果但排除交接与更新仓计数", async (t) => {
  for (const hasSuccess of [true, false]) {
    await t.test(hasSuccess ? "与成功仓混合时只交接成功仓" : "只有 skipped 时不触发系统聚合", async () => {
      const skippedReceipt = { ...OLD, actionTaken: "skipped" };
      const h = harness([
        repo("explicitly-skipped-service"), ...(hasSuccess ? [repo("order-service")] : []), system(),
      ], {
        poll: (item, _count, now) => ({
          ...aligned(), checkpointUpdatedAt: new Date(now).toISOString(),
          ...(item.repo === "explicitly-skipped-service" ? skippedReceipt : CURRENT),
        }),
      });
      const result = await h.run() as PipelineSummary;
      assert.equal(result.failed, 0);
      assert.equal(result.completed, hasSuccess ? 3 : 1);
      assert.equal(result.skipped, hasSuccess ? 0 : 1);
      assert.equal(result.results[0]!.status, "completed");
      assert.deepEqual(metadata(result.results[0]!), skippedReceipt);
      const sys = h.dispatched.find((item) => item.repoType === "system_knowledge");
      if (hasSuccess) {
        assert.ok(sys);
        assertRelated(sys);
        assert.match(sys.codePhaseSummary, /共 1 个，仅包含本次成功任务/);
        assert.match(sys.codePhaseSummary, /仓库：order-service/);
        assert.doesNotMatch(sys.codePhaseSummary, /explicitly-skipped-service/);
        assertNoHistory(sys.prompt);
      } else {
        assert.equal(sys, undefined);
        assert.ok(!h.events.includes("sync:system-knowledge"));
        assert.equal(result.results.at(-1)!.status, "skipped");
        assert.match(result.results.at(-1)!.message, /没有成功完成补齐的代码仓.*跳过定向系统聚合/);
      }
      assert.equal(result.inboxSkipped, true);
    });
  }
});

test("交接清单：缺省与显式空数组区分，旧字段或无效清单不能被宣称为本次无改动", async (t) => {
  const cases: { title: string; fields: Record<string, unknown>; expected: KnowledgeChange[] | undefined }[] = [
    { title: "缺省", fields: {}, expected: undefined },
    { title: "显式无改动", fields: { knowledgeChanges: [] }, expected: [] },
    { title: "旧 summary 和旧清单字段", fields: { summary: OLD.checkpointSummary, changedDocuments: OLD.knowledgeChanges }, expected: undefined },
    { title: "null", fields: { knowledgeChanges: null }, expected: undefined },
    { title: "错误容器", fields: { knowledgeChanges: {} }, expected: undefined },
    { title: "项缺少主题", fields: { knowledgeChanges: [{ path: "docs/knowledge/flow/flow-order.md" }] }, expected: undefined },
    { title: "路径为空串", fields: { knowledgeChanges: [{ path: "", summary: "订单恢复" }] }, expected: undefined },
    { title: "路径只有空白", fields: { knowledgeChanges: [{ path: " \t ", summary: "订单恢复" }] }, expected: undefined },
    { title: "主题为空串", fields: { knowledgeChanges: [{ path: "docs/knowledge/flow/flow-order.md", summary: "" }] }, expected: undefined },
    { title: "主题只有空白", fields: { knowledgeChanges: [{ path: "docs/knowledge/flow/flow-order.md", summary: " \n " }] }, expected: undefined },
    { title: "混合有效无效项不能部分采用", fields: { knowledgeChanges: [CURRENT.knowledgeChanges[0], { path: 42, summary: "invalid" }] }, expected: undefined },
  ];
  for (const { title, fields, expected } of cases) {
    await t.test(title, async () => {
      const h = harness([repo("order-service", { ...OLD }), system()], {
        poll: (_item, _count, now) => ({ ...aligned(), checkpointUpdatedAt: new Date(now).toISOString(), ...fields }),
      });
      const result = await h.run() as PipelineSummary;
      assert.equal(result.completed, 2);
      const code = result.results[0]!;
      assert.deepEqual(code.knowledgeChanges, expected);
      assert.equal(Object.hasOwn(code, "knowledgeChanges"), expected !== undefined);
      assert.equal(Object.hasOwn(code, "checkpointSummary"), false);
      assert.equal(Object.hasOwn(code, "actionTaken"), false);
      const invalidList = Object.hasOwn(fields, "knowledgeChanges") && expected === undefined;
      assert.equal(h.logs.filter((message) => /\[WARN\].*本次知识变更清单格式无效/.test(message)).length, invalidList ? 2 : 0);
      const sys = h.dispatched[1]!;
      assertRelated(sys);
      assert.match(sys.codePhaseSummary, /本次主题摘要：未回传，须读取该仓知识索引与文档核验/);
      if (expected === undefined) {
        assert.match(sys.codePhaseSummary, /未回传清单，不能据此认定无改动/);
        assert.match(sys.codePhaseSummary, /请仅围绕该仓知识目录与相关主题定向核验/);
        assert.doesNotMatch(sys.codePhaseSummary, /本次未产生文档改动（已核验）/);
      } else {
        assert.match(sys.codePhaseSummary, /本次未产生文档改动（已核验）/);
        assert.doesNotMatch(sys.codePhaseSummary, /未回传清单/);
      }
      assertNoHistory(sys.prompt);
    });
  }
});

test("交接时效：仅采用判定完成且时间不早于派发的记录，不能缓存失败或旧轮询的元数据", async (t) => {
  for (const first of [
    { title: "新时间但 error", fields: { status: "error", checkpointUpdatedAt: new Date(START + 10).toISOString() } },
    { title: "旧时间且提交对齐", fields: { checkpointUpdatedAt: new Date(START - 1).toISOString() } },
  ]) {
    await t.test(first.title, async () => {
      const h = harness([repo("order-service"), system()], {
        poll: (item, count, now) => item.repoType === "code" && count === 1
          ? { ...aligned(), ...OLD, ...first.fields }
          : { ...aligned(), checkpointUpdatedAt: new Date(now).toISOString() },
      });
      const result = await h.run() as PipelineSummary;
      assert.equal(result.completed, 2);
      assert.equal(h.polls.get("order-service"), 2);
      assert.deepEqual(metadata(result.results[0]!), {});
      assertNoHistory(h.dispatched[1]!.prompt);
      assert.match(h.dispatched[1]!.codePhaseSummary, /未回传清单/);
    });
  }
  await t.test("恰好等于派发时间的 receipt 仍可交接", async () => {
    const h = harness([repo("order-service")], {
      poll: () => ({ ...aligned(), checkpointUpdatedAt: new Date(START).toISOString(), ...CURRENT }),
    });
    const result = await h.run({ skipSystemKnowledge: true }) as PipelineSummary;
    assert.equal(result.completed, 1);
    assert.deepEqual(metadata(result.results[0]!), CURRENT);
  });
});

test("增量兼容：旧服务端无合法时间可按 commit 完成，但不采用任何历史交接元数据", async (t) => {
  for (const checkpointUpdatedAt of [undefined, "", "invalid"]) {
    await t.test(String(checkpointUpdatedAt), async () => {
      const h = harness([repo("order-service", { status: "changed", hasChanges: true, ...OLD }), system()], {
        poll: () => ({ ...aligned(), checkpointUpdatedAt, ...OLD }),
      });
      const result = await h.run({ mode: "incremental", skipInbox: true }) as PipelineSummary;
      assert.equal(result.completed, 2);
      assert.equal(h.polls.get("order-service"), 1);
      assert.deepEqual(metadata(result.results[0]!), {});
      const sys = h.dispatched[1]!;
      assert.equal(sys.systemScope, "full");
      assert.match(sys.prompt, /系统知识库全局聚合维护指导/);
      assert.match(sys.codePhaseSummary, /未回传清单/);
      assertNoHistory(sys.prompt);
    });
  }
});

test("重复补齐：相同 commit 的第二轮必须等待新 receipt，主题和文档清单不复用首轮", async () => {
  const previous = new Map<string, Record<string, unknown>>();
  const h = harness([repo("order-service"), system()], {
    poll: (item, count, now) => {
      if (count === 2) return previous.get(item.repo!)!;
      const receipt = {
        ...aligned(), checkpointUpdatedAt: new Date(now).toISOString(),
        ...(item.repoType === "code" ? (count === 1 ? OLD : CURRENT) : {}),
      };
      previous.set(item.repo!, receipt);
      return receipt;
    },
  });
  const first = await h.run() as PipelineSummary;
  assert.equal(first.completed, 2);
  assert.deepEqual(metadata(first.results[0]!), OLD);
  h.advance(100);
  const second = await h.run() as PipelineSummary;
  assert.equal(second.completed, 2);
  assert.equal(second.failed, 0);
  assert.deepEqual(metadata(second.results[0]!), CURRENT);
  assert.equal(h.polls.get("order-service"), 3);
  assert.equal(h.polls.get("system-knowledge"), 3);
  assert.equal(h.dispatched.length, 4);
  assertNoHistory(h.dispatched[3]!.prompt);
  assert.ok(h.dispatched[3]!.codePhaseSummary.includes(CURRENT.checkpointSummary));
});

test("预演交接：只预告本次待处理仓目录，不注入历史清单、历史主题或扫描失败仓", async () => {
  const h = harness([
    repo("order-service", { ...OLD }), repo("scan-failed", { status: "error", ...OLD }),
    repo("unselected-service", { ...OLD }), system("system-knowledge", { ...OLD }),
  ]);
  const result = await h.run({ dryRun: true, only: "order-service,scan-failed" }) as DryRunResult;
  assert.equal(result.total, 3);
  assert.equal(result.pending, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.dryRunOutput.map((item) => item.repo), ["order-service", "system-knowledge"]);
  const sys = result.dryRunOutput[1]!.placeholders;
  assertRelated(sys);
  assert.match(sys.codePhaseSummary, /预演阶段待维护代码仓共 1 个/);
  assert.match(sys.codePhaseSummary, /路径：\/srv\/workspace\/order-service；知识目录：\/srv\/workspace\/order-service\/docs\/knowledge\//);
  assert.match(sys.codePhaseSummary, /本次文档清单与主题摘要将在单仓实际完成后注入，预演不复用历史交接记录/);
  assert.doesNotMatch(sys.codePhaseSummary, /scan-failed|unselected-service|本次未产生文档改动/);
  assertNoHistory(sys.prompt);
  assert.equal(h.dispatched.length, 0);
  assert.deepEqual(h.events, ["scan"]);
  assert.equal(result.inboxSkipped, true);
});

test("单仓提示词：普通维护与冲突消解均要求 complete 交接主题与逐篇路径，无改动显式 []", async (t) => {
  for (const mode of ["backfill", "incremental"] as const) {
    for (const isConflict of [false, true]) {
      await t.test(`${mode} conflict=${isConflict}`, () => {
        const { prompt } = buildPlaceholders(repo("order-service"), { mode, isConflict });
        assert.equal(prompt.split("## 本次知识变更交接").length - 1, 1);
        for (const required of [
          "调用 maintenance.complete 时，summary 概括本次涉及的流程、契约、规则与跨仓影响",
          "knowledgeChanges 数组", "安全的仓库相对文档路径", "该文档的主题及新增、修改或删除说明",
          'knowledgeChanges.0.path="docs/knowledge/flow/flow-order.md"', "knowledgeChanges.0.summary=",
          "与最终 complete 的 path、commit、actionTaken、summary 一起提交", "knowledgeChanges:=[]",
          "清单缺省表示未回传，不等于没有改动", "不用历史记录或发布后为空的工作区 diff 代替本次变更",
          "不要在单仓任务中直接修改系统仓",
        ]) assert.ok(prompt.includes(required), required);
        if (mode === "backfill" && isConflict) {
          assert.match(prompt, /冲突消解只是前置步骤.*不得调用 maintenance\.complete 提前结束/);
          assert.doesNotMatch(prompt, /actionTaken="conflict_resolved"/);
          assert.ok(prompt.indexOf("## 本次知识变更交接") > prompt.indexOf(BACKFILL_SECTION));
        }
      });
    }
  }
});

test("Action 交接输出：FakeProcessDriver 将本次 docs/topics 传入系统 prompt 并保留缺省与 []", async (t) => {
  const cases = [
    { title: "本次逐篇交接", fields: CURRENT, legacy: false },
    { title: "显式无改动", fields: { actionTaken: "no_change_needed", checkpointSummary: "已核验订单及支付链路无文档缺口", knowledgeChanges: [] }, legacy: false },
    { title: "本次完成但清单缺省", fields: {}, legacy: false },
    { title: "旧增量服务端仅按 commit 兜底", fields: OLD, legacy: true },
  ];
  for (const { title, fields, legacy } of cases) {
    await t.test(title, async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-handoff-"));
      try {
        const driver = new FakeProcessDriver();
        const commands: string[] = [];
        const dispatches: string[] = [];
        const unexpected: string[] = [];
        const items = [system(), repo("order-service", { status: "changed", hasChanges: true, ...OLD })];
        driver.onSpawn = (handle, spec) => {
          assert.equal(spec.executable, "sh");
          assert.equal(spec.args?.[0], "-c");
          const command = spec.args?.[1] ?? "";
          commands.push(command);
          let data: unknown;
          if (command.startsWith("ad run maintenance.list ")) {
            data = !command.includes("-- path=") ? { batch: true, results: items } : {
              ...aligned(), ...(legacy ? {} : { checkpointUpdatedAt: new Date(Date.now() + 1000).toISOString() }),
              ...(command.includes('-- path="/srv/workspace/order-service"') ? fields : {}),
            };
          } else if (command.startsWith("ad run maintenance.sync ")) {
            data = { status: "success", currentCommit: COMMIT };
          } else if (command.startsWith("dispatch ")) {
            dispatches.push(command);
          } else {
            unexpected.push(command);
          }
          if (data !== undefined) driver.emitOutput(handle, "stdout", reply(data).stdout);
          driver.emitExit(handle, { code: 0, signal: null });
          driver.emitOutputClosed(handle, "natural");
        };
        const runtime = createTestRuntime({ platform: createTestPlatform({ processDriver: driver }) });
        const output = await runtime.run(pipelineAction, {
          mode: legacy ? "incremental" : "backfill", skipInbox: legacy,
          ...(legacy ? {} : { only: "order-service" }),
          dispatchCmd: 'dispatch {{repo}} "{{prompt}}"', interval: 0.001, timeout: 1,
          reportFile: path.join(tmp, "report.md"),
        });
        assert.deepEqual(unexpected, []);
        assert.equal(output.success, true);
        assert.equal(output.total, 2);
        assert.equal(output.completed, 2);
        assert.equal(output.failed, 0);
        assert.equal(output.inboxSkipped, true);
        assert.deepEqual(output.results.map((item) => item.repo), ["order-service", "system-knowledge"]);
        assert.deepEqual(metadata(output.results[0] as RepoResult), legacy ? {} : fields);
        assert.equal(Object.hasOwn(output.results[0]!, "knowledgeChanges"), !legacy && Object.hasOwn(fields, "knowledgeChanges"));
        assert.equal(dispatches.length, 2);
        const sys = dispatches[1]!;
        assert.match(sys, legacy ? /系统知识库全局聚合维护指导/ : /系统知识库定向聚合任务指导/);
        assert.ok(!sys.includes(BACKFILL_SECTION));
        assert.ok(sys.includes("路径：/srv/workspace/order-service"));
        assert.ok(sys.includes("知识目录：/srv/workspace/order-service/docs/knowledge/"));
        assertNoHistory(sys);
        if (!legacy && "checkpointSummary" in fields) assert.ok(sys.includes(fields.checkpointSummary!));
        if (!legacy && "knowledgeChanges" in fields) {
          for (const change of fields.knowledgeChanges!) assert.ok(sys.includes(`${change.path}：${change.summary}`));
          if (fields.knowledgeChanges!.length === 0) assert.ok(sys.includes("本次未产生文档改动（已核验）"));
        } else {
          assert.ok(sys.includes("未回传清单，不能据此认定无改动"));
          assert.ok(!sys.includes("本次未产生文档改动（已核验）"));
        }
        assert.equal(driver.spawnCalls.length, commands.length);
        assert.ok(commands.every((command) => /^(?:ad run maintenance\.(?:list|sync) |dispatch )/.test(command)));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});
