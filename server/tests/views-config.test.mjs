// ==============================================================================
// views-config.test.mjs - 视图配置跨版本兼容性测试
//
// 覆盖两类事实源：
// 1. views-bootstrap.cjs 内置默认视图（未挂载 views.json 时的生成路径）
// 2. server/config/views.json.example（挂载配置模板）
//
// 校验内容：
// - 全部 actionAllowlist 引用为全限定 packageId/actionId 形态，
//   通过 @actiondock/core normalizeServerViews 2.20.0 的启动校验
// - 包标识通过 assertValidPackageId 校验
// - 授权语义按 2.20.0 并集模型（整包授权 OR 全限定单动作授权）等价迁移：
//   sk 视图实际可调用动作集合与旧版交集语义完全一致
// ==============================================================================
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
// 解析与 serve 端同源的 core 策略实现；node_modules 锁定 2.13.0 时，本文件用
// ACTIONDOCK_TEST_CORE_DIST 指向解包的 2.20.0 dist 目录以获得新语义，
// 未设置时直接消费仓库依赖（要求已对齐 2.20.0）
const coreDist = process.env.ACTIONDOCK_TEST_CORE_DIST
  ? require(join(process.env.ACTIONDOCK_TEST_CORE_DIST, "dist", "server", "policy.js"))
  : { ...await import("@actiondock/core/server") };
const core = coreDist;

// 内置包全集，用于按并集语义推演视图实际可调用的动作集合
const BUILTIN_PACKAGES = {
  workspace: ["search.rg", "files.read", "files.list", "files.write", "files.edit", "bash.exec", "links.verify"],
  knowledge: ["knowledge.collect", "knowledge.list", "knowledge.archive", "knowledge.query", "knowledge.leaderboard", "knowledge.get"],
  maintenance: ["maintenance.sync", "maintenance.list", "maintenance.complete", "maintenance.publish"],
};
const ALL_ACTIONS = Object.entries(BUILTIN_PACKAGES).flatMap(([packageId, actionIds]) =>
  actionIds.map((actionId) => ({ packageId, actionId })),
);
const fqn = (a) => `${a.packageId}/${a.actionId}`;

// sk 视图的业务预期：仅只读检索与向待审池受控追加，不含任何写入、编辑或命令执行
const SK_EXPECTED_ACTIONS = [
  "workspace/search.rg",
  "workspace/files.read",
  "workspace/files.list",
  "knowledge/knowledge.collect",
  "knowledge/knowledge.get",
  "knowledge/knowledge.query",
  "knowledge/knowledge.leaderboard",
];

function runBootstrap(env) {
  const dir = mkdtempSync(join(tmpdir(), "kd-views-test-"));
  const outFile = join(dir, "views.json");
  const script = join(repoRoot, "server", "views-bootstrap.cjs");
  execFileSync(process.execPath, [script], {
    env: {
      ...process.env,
      // bootstrap 对令牌强校验，注入固定测试令牌（长度满足 32 字符要求）
      ACTIONDOCK_TOKEN: "a".repeat(40),
      ACTIONDOCK_AGENT_TOKEN: "b".repeat(40),
      OPS_TOKEN: "c".repeat(40),
      VIEWS_FILE: outFile,
      MOUNTED_VIEWS: env.MOUNTED_VIEWS ?? "",
    },
  });
  return JSON.parse(require("node:fs").readFileSync(outFile, "utf-8"));
}

function assertViewPassesStartup(view, name) {
  assert.doesNotThrow(
    () => core.normalizeServerViews({ views: { [name]: { token: "t".repeat(32), ...view } } }),
    `视图 ${name} 应通过 2.20.0 启动校验`,
  );
}

// 按并集语义推演视图实际可调用的动作集合
function effectiveActions(view) {
  return ALL_ACTIONS.filter((a) => core.isActionAllowedByPolicy(a, view)).map(fqn).sort();
}

// 场景一：内置默认路径（未挂载 views.json）
{
  const views = runBootstrap({});
  assert.ok(views.sk, "内置默认应生成 sk 视图");
  assert.ok(views.skm, "内置默认应生成 skm 视图");
  assert.ok(views.default, "内置默认应生成 default 视图");
  assert.equal(views.sk.packageAllowlist.length, 0, "内置 sk 视图 packageAllowlist 必须为空，防止整包授权放大");
  assertViewPassesStartup(views.sk, "sk");
  assertViewPassesStartup(views.skm, "skm");
  assert.deepEqual(effectiveActions(views.sk), [...SK_EXPECTED_ACTIONS].sort(), "内置 sk 视图实际授权必须与业务预期完全一致");
  assert.deepEqual(
    effectiveActions(views.skm),
    ALL_ACTIONS.map(fqn).sort(),
    "内置 skm 视图应覆盖全部内置包动作",
  );
}

// 场景二：挂载 views.json.example 模板（模拟运维复制模板后未改动核心字段的场景）
{
  const examplePath = join(repoRoot, "server", "config", "views.json.example");
  const views = runBootstrap({ MOUNTED_VIEWS: examplePath });
  assertViewPassesStartup(views.sk, "sk");
  assertViewPassesStartup(views.skm, "skm");
  assertViewPassesStartup(views.ops, "ops");
  assert.deepEqual(effectiveActions(views.sk), [...SK_EXPECTED_ACTIONS].sort(), "模板 sk 视图实际授权必须与业务预期完全一致");
}

console.log("views-config: all tests passed");
