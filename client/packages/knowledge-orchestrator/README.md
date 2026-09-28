# 客户端编排动作包

`knowledge-orchestrator` 在执行机本地运行 `orchestrator.pipeline`，依次巡检业务仓、处理系统知识仓、串行消费待审候选。它通过维护视图读取远端状态，使用调用方提供的 `dispatchCmd` 派发智能体，并等待检查点或归档状态变化。

本仓开发时可以本地挂载：

```bash
ad link ./client/packages/knowledge-orchestrator
ad run orchestrator.pipeline -- profile="skm" dryRun:=true
```

调度器是客户端控制平面动作，调用 `ad run orchestrator.pipeline` 时不要附加全局 `--profile`。`--` 后的 `profile="skm"` 才是调度器内部访问远端的配置名。

正式运行需要能在当前执行机调用的智能体派发命令。下例中的 `my-agent.dispatch` 需要由接入方提供：

```bash
ad run orchestrator.pipeline -- \
  profile="skm" \
  dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"'
```

`dryRun:=true` 只查询和预览仓库任务，不派发智能体或消费待审池。`only` 限定仓库，`skipSystemKnowledge` 和 `skipInbox` 跳过对应阶段；`timeout`、`interval` 控制等待与轮询。`reportFile` 默认为当前目录下的 `maintenance-report.md`，`logFile` 可指定追加日志路径。

动作输入、输出和占位符以 [actiondock.json](actiondock.json) 为准。运行方式、阶段条件及故障处理分别见[编排指南](../../../docs/orchestration.md)和[运维手册](../../../docs/operations.md)。

本地开发可在包目录运行 `npm run typecheck` 与 `npm test`。
