# 客户端编排动作包

`knowledge-orchestrator` 在执行机本地运行 `orchestrator.pipeline`，依次巡检业务仓、处理系统知识仓、串行消费待审候选。它通过维护视图读取远端状态，使用调用方提供的 `dispatchCmd` 派发智能体，并等待检查点或归档状态变化。

本仓开发时可以本地挂载：

```bash
ad link ./client/packages/knowledge-orchestrator
ad run orchestrator.pipeline -- profile="skm" dryRun:=true \
  dispatchCmd='ad run my-agent.dispatch -- repo="{{repo}}" prompt="{{prompt}}"'
```

调度器是客户端控制平面动作，调用 `ad run orchestrator.pipeline` 时不要附加全局 `--profile`。`--` 后的 `profile="skm"` 才是调度器内部访问远端的配置名。

正式运行需要能在当前执行机调用的智能体派发命令。下例中的 `my-agent.dispatch` 需要由接入方提供：

```bash
ad run orchestrator.pipeline -- \
  profile="skm" \
  dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"'
```

`dryRun:=true` 只查询和预览仓库任务，不派发智能体或消费待审池。`only` 限定仓库，`skipSystemKnowledge` 和 `skipInbox` 跳过对应阶段；`timeout`、`interval` 控制等待与轮询。`reportFile` 默认为当前目录下的 `maintenance-report.md`，`logFile` 可指定追加日志路径。

## 源码覆盖补齐

`mode` 可选 `incremental`（默认，按变更维护）或 `backfill`（源码覆盖补齐）。补齐复用 `only="repo-a,repo-b"`：仓库名精确匹配，忽略大小写和前后空白；不提供 `only` 时处理所有代码仓和系统知识仓。`only` 未命中或包含不能处理的仓库时报错，错误仓仍判失败，避免静默漏执行。

`backfill` 优先于无变更跳过与已有文档 `scope` 门槛：指定代码仓即使无代码变更、检查点已对齐，也同步并派发源码覆盖补齐任务。`only` 不切断后续聚合：单仓完成后自动唤醒受管系统知识仓代理，传递本次文档清单和主题摘要，定向更新相关领域与跨仓流程，而非重新全景扫描。只有显式 `skipSystemKnowledge:=true` 才仅补单仓；未配置系统仓且未显式跳过时报错。Inbox 始终跳过。

仅指定系统知识仓、没有代码仓任务时，执行系统层全景补齐。代码仓任务全部失败时不派发定向聚合；部分成功只交接成功仓，不将失败仓视为已同步。预演会列出自动纳入的系统仓，但本次文档清单要等单仓实际完成后注入，不读取历史记录冒充。

维护智能体从当前源码真实入口、注册表、公共导出和测试发现主题，不局限于 Git diff 或已有 scope；对照文档补充首次遗漏的流程、分支、契约、规则和恢复路径。保留人工内容和既有有效知识，不按篇数凑数、不全量重写。单仓只写本仓 `docs/knowledge/`，系统仓只写目标系统仓，其他仓可只读核验。必须产生新的 `checkpointUpdatedAt` 本次完成记录才判成功，旧同 commit 记录不能提前结束任务。这不是自动完整性验收器，不保证全仓知识完整。

多仓补齐预演（去掉 `dryRun:=true` 后正式执行）：

```bash
ad run orchestrator.pipeline -- profile="skm" mode="backfill" only="repo-a,repo-b" dryRun:=true \
  dispatchCmd='ad run my-agent.dispatch -- repo="{{repo}}" prompt="{{prompt}}"'
```

派发模板可用 `{{mode}}` 获取当前模式，`{{systemScope}}` 区分系统层的 `related` 定向聚合与 `full` 全景补齐；需保留 `prompt="{{prompt}}"` 传递完整维护要求。

## 单仓结果交接

维护代理在发布前记录本任务的知识文档变更，在 `maintenance.complete` 中提交 `summary`（本次主题与跨仓影响）及 `knowledgeChanges`（每项含仓库相对文档路径 `path`、主题与变更说明 `summary`）。无改动显式传 `knowledgeChanges:=[]`；未提供清单不代表没有改动。

`maintenance.list` 从最新完成记录返回 `checkpointSummary` 和 `knowledgeChanges`。调度器仅将本次新完成记录的元数据注入 `codePhaseSummary`，连同仓库绝对路径、知识目录和检查点传给系统代理，并保留在流水线结果中。旧服务端缺少这些字段时，交接明确标记缺失，要求围绕对应仓库定向核验，不使用历史摘要代替。本协议需同步更新客户端和服务端维护包。

## 结果展示

`orchestrator.pipeline` 不声明默认正文，默认保留完整结构化结果，预演时可直接查看 `dryRunResults` 中的派发命令。需要完整执行信封时，在 `--` 前添加 `--json`。

使用支持正文选择的 ActionDock CLI 时，正式运行可显式指定 `--text-field report`，将 Markdown 报告原样输出到标准输出，其他统计和明细以 JSON 输出到标准错误流：

```bash
ad run orchestrator.pipeline --text-field report -- \
  profile="skm" \
  dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"'
```

预演报告不包含完整派发命令，核验命令时不要只提取 `report`。`--text-field` 与 `--json`、`--async` 互斥；本地流水线需要后台运行时使用 `nohup`，不使用 CLI 的 `--async`。标准错误流还可能包含日志，不应作为独立的数据协议解析。

动作输入、输出和占位符以 [actiondock.json](actiondock.json) 为准。运行方式、阶段条件及故障处理分别见[编排指南](../../../docs/orchestration.md)和[运维手册](../../../docs/operations.md)。

本地开发可在包目录运行 `npm run typecheck` 与 `npm test`。
