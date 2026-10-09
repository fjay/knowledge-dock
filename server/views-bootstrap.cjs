// ==============================================================================
// views-bootstrap.cjs - 视图权限启动解析器
//
// 职责：优先读取挂载的原生 ActionDock views 配置（与 ad serve --views-file 格式
// 完全一致，支持裸对象、{"views":{}} 与 {"server":{"views":{}}} 三种形态），
// 未提供时按内置默认生成 sk/skm/default 三视图，写入运行时临时文件。
//
// 安全约束：
// - token 字段支持 ${ENV_VAR} 环境变量引用，令牌不落盘；引用缺失即失败
// - 令牌长度不足 32 字符、疑似占位符、跨视图重复，直接以非零码退出
// - default 视图缺少 token 时注入随机令牌，阻断 serve 端回落读取
//   ACTIONDOCK_TOKEN 环境变量导致查询令牌获得全量权限
// ==============================================================================
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const mountedPath = process.env.MOUNTED_VIEWS || "";
const outFile = process.env.VIEWS_FILE || "/run/actiondock-views.json";

const PLACEHOLDER_PATTERNS = [
  /your-random-secure/i,
  /your-token-here/i,
  /example-token/i,
  /changeme/i,
];

const VIEW_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

// 内置默认 sk 视图 action 白名单（与 Dockerfile ENV SK_ACTION_ALLOWLIST 一致）
const BUILTIN_SK_ACTION_ALLOWLIST = [
  "workspace/search.rg",
  "workspace/files.read",
  "workspace/files.list",
  "knowledge/knowledge.collect",
  "knowledge/knowledge.get",
  "knowledge/knowledge.query",
  "knowledge/knowledge.leaderboard",
  "search.rg",
  "files.read",
  "files.list",
  "knowledge.collect",
  "knowledge.get",
  "knowledge.query",
  "knowledge.leaderboard",
];

function fail(message) {
  console.error("[VIEWS ERROR] " + message);
  process.exit(1);
}

// 将 token 中的 ${ENV_VAR} 引用替换为环境变量值，引用未设置或为空直接失败
function resolveTokenEnv(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    const envValue = process.env[name];
    if (!envValue) {
      fail(`token 引用的环境变量 \${${name}} 未设置或为空`);
    }
    return envValue;
  });
}

// 与 cli 端 loadViewsFromFile 相同的形态归一化逻辑
function extractViews(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    if (parsed.views && typeof parsed.views === "object") {
      return parsed.views;
    }
    if (parsed.server && typeof parsed.server === "object" && parsed.server.views) {
      return parsed.server.views;
    }
    return parsed;
  }
  fail("views 配置必须是 JSON 对象或数组");
}

// "$" 与 "__" 前缀键视为注释性元数据，跳过并从输出中剔除
function isMetaKey(key) {
  return key.startsWith("$") || key.startsWith("__");
}

const views = {};

if (mountedPath && fs.existsSync(mountedPath)) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(mountedPath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`解析 ${mountedPath} 失败: ${msg}`);
  }

  const entries = extractViews(parsed);
  if (Array.isArray(entries)) {
    entries.forEach((item, index) => {
      if (item === null || item === undefined) return;
      if (typeof item !== "object") {
        fail(`${mountedPath} views 数组第 ${index} 项不是对象`);
      }
      const name = (typeof item.name === "string" && item.name.trim()) || `view_${index}`;
      views[name] = item;
    });
  } else {
    for (const [key, item] of Object.entries(entries)) {
      if (isMetaKey(key)) continue;
      if (item === null || item === undefined) continue;
      if (typeof item !== "object") {
        fail(`${mountedPath} 中视图 "${key}" 的定义不是对象`);
      }
      views[key.trim()] = item;
    }
  }

  const viewNames = Object.keys(views);
  if (viewNames.length === 0) {
    fail(`${mountedPath} 未包含任何有效视图定义`);
  }
  for (const name of viewNames) {
    if (!VIEW_NAME_PATTERN.test(name)) {
      fail(`视图名 "${name}" 含非法字符，仅允许字母、数字、下划线与连字符`);
    }
  }

  // 令牌解析与强校验：缺失、过短、占位符、跨视图重复一律阻断启动
  const tokenOwners = new Map();
  for (const name of viewNames) {
    const view = views[name];
    const rawToken = typeof view.token === "string" ? view.token.trim() : "";
    if (!rawToken) {
      if (name === "default") continue; // default 允许缺省，稍后注入随机令牌
      fail(`视图 "${name}" 缺少 token 字段，可使用 \${ACTIONDOCK_TOKEN} 形式的环境变量引用或字面量令牌`);
    }
    const token = resolveTokenEnv(rawToken);
    if (token.length < 32) {
      fail(`视图 "${name}" 的 token 长度不足 32 字符`);
    }
    if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(token))) {
      fail(`视图 "${name}" 的 token 疑似示例占位符`);
    }
    if (tokenOwners.has(token)) {
      fail(`视图 "${tokenOwners.get(token)}" 与 "${name}" 使用了相同 token，令牌必须互不相同`);
    }
    tokenOwners.set(token, name);
    view.token = token;
  }

  // 全部视图都无显式令牌（如仅空的 default）意味着服务无人可用，视为误配置
  if (tokenOwners.size === 0) {
    fail(`${mountedPath} 中没有任何携带 token 的视图，服务将无法被访问`);
  }
} else {
  // 未挂载配置：按内置默认生成（令牌合法性已由 entrypoint 前置校验）
  const skAllowlist = process.env.SK_ACTION_ALLOWLIST
    ? process.env.SK_ACTION_ALLOWLIST.split(",").map((item) => item.trim()).filter(Boolean)
    : BUILTIN_SK_ACTION_ALLOWLIST;

  views.sk = {
    token: process.env.ACTIONDOCK_TOKEN,
    packageAllowlist: ["workspace", "knowledge"],
    actionAllowlist: skAllowlist,
  };
  views.skm = {
    token: process.env.ACTIONDOCK_AGENT_TOKEN,
    packageAllowlist: ["workspace", "knowledge", "maintenance"],
  };
}

// default 视图兜底：未显式提供 token 时注入随机令牌，
// 避免 ACTIONDOCK_TOKEN 环境变量回落成 default 视图令牌造成越权
if (!views.default || typeof views.default.token !== "string" || !views.default.token.trim()) {
  views.default = {
    ...(views.default || {}),
    name: "default",
    token: crypto.randomBytes(32).toString("hex"),
  };
}

// 剔除注释性元数据键，输出纯净的原生视图配置
for (const key of Object.keys(views)) {
  if (isMetaKey(key)) delete views[key];
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(views), { mode: 0o600 });
fs.chmodSync(outFile, 0o600);

console.log(`[INFO] Effective views: ${Object.keys(views).join(", ")}`);
