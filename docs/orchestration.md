# 编排指南

`orchestrator.pipeline` 是在执行机本地运行的客户端控制平面动作。它查询远端仓库状态，按需运行你提供的智能体派发命令，并轮询检查点或候选归档状态。它本身不编写文档，也不提供维护智能体运行时。

## 接入条件

- 服务端已部署，仓库已同步，执行机已配置维护视图 `skm`。
- 执行机可调用 `ad`，并已安装或本地挂载客户端编排包。本仓开发环境可使用：

  ```bash
  ad link ./client/packages/knowledge-orchestrator
  ```

- 正式运行前准备一个可在执行机调用的智能体派发命令。该命令需要接收仓库或候选上下文，并让维护任务最终推进检查点或归档候选。未接入派发器时，只能使用预演模式。

先预演远端增量扫描：

```bash
ad run orchestrator.pipeline -- profile="skm" dryRun:=true
```

`--profile skm` 是 ActionDock 的全局控制选项，会把当前动作发往远端；本地调度器不能使用它。这里的 `profile="skm"` 位于 `--` 后，是调度器连接服务端的数据入参。预演只查询状态并生成待派发清单，不运行维护智能体，也不推进检查点；它不会消费待审池。

## 调度顺序

| 阶段 | 触发条件 | 完成标记 |
|---|---|---|
| 业务仓巡检 | 主干提交超过检查点，或首次接入 | 维护任务推进到本轮目标提交 |
| 系统知识聚合 | 业务仓有待审变更，或系统知识仓自身有新提交 | 系统知识仓检查点推进 |
| 待审池消费 | 存在 `pending` 候选 | 当前候选从待审池归档 |

系统知识阶段接收前序仓库的变更摘要，以便核对跨仓业务流程。待审池按候选逐个处理，避免多个任务同时编辑同一份正式知识。调度器等待状态变化；派发命令退出成功不等于维护已完成。

## 派发命令

`dispatchCmd` 是命令模板，调度器在本机执行渲染结果。下例中的 `my-agent.dispatch` 是接入方需要提供的动作名称，并非本仓自带组件：

```bash
ad run orchestrator.pipeline -- \
  profile="skm" \
  dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"'
```

先用自己的真实派发命令替换示例，再加 `dryRun:=true` 检查渲染结果。常用占位符包括 `{{repo}}`、`{{path}}`、`{{from}}`、`{{to}}`、`{{prompt}}`、`{{codePhaseSummary}}` 和待审池任务使用的 `{{candidateId}}`、`{{candidateTitle}}`、`{{candidateFilename}}`。完整字段由客户端包的 `actiondock.json` 和[子包 README](../client/packages/knowledge-orchestrator/README.md)定义。

命令模板会交给本地 shell 执行，派发器应只接受受信任的模板。仓库名、标题等动态内容由调度器进行模板转义；仍应在预演结果中检查最终命令与目标任务是否对应。

## 常用参数

| 入参 | 默认值 | 用途 |
|---|---|---|
| `profile` | `skm` | 远端维护视图配置名 |
| `dispatchCmd` | 空 | 正式运行时必填的派发命令模板 |
| `dryRun` | `false` | 只扫描并预览待派发任务 |
| `only` | 全部仓库 | 以仓库名或逗号分隔名称缩小范围 |
| `skipSystemKnowledge` | `false` | 跳过系统知识聚合 |
| `skipInbox` | `false` | 跳过待审池消费 |
| `timeout` | `15` | 单个任务等待检查点变化的分钟数 |
| `interval` | `10` | 轮询间隔秒数 |
| `reportFile` | `maintenance-report.md` | 本地 Markdown 结算报告路径 |
| `logFile` | 未指定 | 本地追加日志路径 |

环境变量 `COMMAND_TIMEOUT_MS` 控制流水线内单条远端查询 shell 命令（扫描、同步、检查点轮询）的超时，默认 600000（10 分钟）。首轮批量扫描含自动克隆时耗时较长，必要时可调大；不建议低于 60000。

例如，只预演某个仓库：

```bash
ad run orchestrator.pipeline -- profile="skm" only="order-service" dryRun:=true
```

正式任务结束后先看动作结果中的失败数，再读 `reportFile`。检查点未推进或候选未归档时，应查看对应智能体任务的错误和服务端动作返回值；不要仅凭派发命令的退出状态认定任务成功。

单仓维护顺序见[维护流程](workflow.md)，异常处理见[运维手册](operations.md)。
