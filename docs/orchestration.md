# knowledge-dock 调度指南

---

## 核心警示：纯本地运行与命令行禁区

在开始调度之前，请务必牢记以下核心规则：

- 纯本地运行属性：流水线调度器（`orchestrator.pipeline`）是一个**纯本地动作**，必须在本地终端执行，绝不要也不可能打包到云端容器中跑。
- 命令行控制选项禁区：在终端执行调用时，**命令行严禁附加控制选项** `--profile`！
- 原理解释：如果在命令中写了 `--profile skm`（例如错误写成 `ad run orchestrator.pipeline --profile skm`），ActionDock 会误以为要把调度器自身打包并上传到云端 443 服务端执行。云端既没有安装调度器的本地依赖，也无法在内部直接反向派发外部智能体，必然会报错失败。
- 数据入参区别：入参中的 `profile="skm"` 仅作为数据入参在双短横线（`--`）之后传入，供调度器在向云端查询检查点时使用。由于其默认值本来就是 `skm`，日常使用完全可以直接省略不写。

正确与错误调用对比：

```bash
# 正确调用范例 (命令行无 --profile 控制选项，入参在 -- 之后)
ad run orchestrator.pipeline -- dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"'

# 绝对禁止的错误调用反例 (切勿在命令行添加 --profile 控制选项)
# ad run orchestrator.pipeline --profile skm -- dispatchCmd='...'  <-- 严禁这样写!
```

---

## 本地编排包链接注册

首次运行流水线调度前，需要将本地客户端编排包软链注册到本地全局路由表中：

```bash
ad link client/packages/knowledge-orchestrator
```

注册完成后，通过列表命令确认本地已挂载 `orchestrator.pipeline` 动作：

```bash
ad list
```

---

## 本地运行四种常用姿势

多代码仓批量巡检通常需要一段时间。根据不同场景，推荐以下四种常用运行姿势：

- 姿势一：本地单次测试跑（前台直观查看）：
  在本地终端直接在前台执行，进度与日志会实时打印在控制台上，适合日常调试：
  ```bash
  ad run orchestrator.pipeline -- \
    dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"'
  ```

- 姿势二：预演演练（只看不动手）：
  通过 `dryRun` 选项进行预演。调度器会扫描所有仓库的代码变更、计算模板占位符并打印渲染后的完整派发命令，但不会实际触发外部任务与轮询：
  ```bash
  ad run orchestrator.pipeline -- dryRun:=true
  ```

- 姿势三：后台挂起长跑（防止关终端中断）：
  针对几十个微服务的大批量巡检，推荐使用 `nohup` 在后台常驻运行，防止终端意外关闭导致任务中断：
  ```bash
  nohup ad run orchestrator.pipeline -- \
    logFile="/var/log/knowledge-pipeline.log" \
    dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"' \
    > /var/log/pipeline-stdout.log 2>&1 &
  ```

- 姿势四：实时看日志流式追踪：
  启动后台长跑后，可在任意终端实时追踪调度器的结构化日志：
  ```bash
  tail -f /var/log/knowledge-pipeline.log
  ```

- 定时任务自动化运维（日常巡检）：
  可将调度命令配置进系统的 crontab 定时任务中，例如每天凌晨两点自动执行全仓巡检：
  ```bash
  0 2 * * * ad run orchestrator.pipeline -- logFile="/var/log/knowledge-pipeline.log" dispatchCmd='...'
  ```

---

## 参数字典速查表

在终端执行 `ad run orchestrator.pipeline -- [参数列表]` 时，支持以下输入参数：

| 参数名称 | 类型 | 默认值 | 作用说明与大白话解释 |
|---|---|---|---|
| `dispatchCmd` | 字符串 | 无 | 必填（预演模式除外）。给智能体派活的命令模板，支持使用占位符动态填充参数 |
| `profile` | 字符串 | `skm` | 云端维护视图配置名称。用于调度器内部向云端查检查点，默认就是 `skm`，通常无需填写 |
| `timeout` | 数值 | `15` | 单仓维护最长等待时间（单位为分钟）。超时未打卡将记录失败并继续处理下一个仓库 |
| `interval` | 数值 | `10` | 轮询探测云端检查点是否推进的时间间隔（单位为秒） |
| `dryRun` | 布尔值 | `false` | 预演模式。设为 `true` 时只打印计算出的变量和派发命令，不实际触发任务 |
| `only` | 字符串 | 空 | 只维护指定的仓库。支持单个仓库名或逗号分隔列表，如 `only="order-service,payment-service"` |
| `skipSystemKnowledge` | 布尔值 | `false` | 是否跳过第二阶段的全局系统知识库聚合维护 |
| `reportFile` | 字符串 | `maintenance-report.md` | 结算报告输出路径，记录各仓库维护结果与耗时 |
| `logFile` | 字符串 | 空 | 实时日志追加写入路径，便于使用 `tail -f` 流式追踪 |

---

## 模板常用占位符

在配置 `dispatchCmd` 命令模板时，可以使用占位符让调度器动态注入参数。调度器会自动完成引号安全转义，防止命令注入风险：

- 基础信息占位符：
  - `{{repo}}`：当前代码仓目录名称（如 `order-service`）。
  - `{{path}}`：当前仓库在云端服务工作区的绝对路径（如 `/srv/workspace/order-service`）。
  - `{{branch}}`：当前仓库的目标分支名（业务仓默认为 `release`，系统知识仓默认为 `master`）。
  - `{{repoType}}`：当前仓库类型（`code` 或 `system_knowledge`）。
- 提交差异占位符：
  - `{{from}}`：上一次打卡记录的提交哈希（若是首次接入建库则为 `initial`）。
  - `{{to}}`：当前云端分支最新提交哈希。
  - `{{commitCount}}`：待核验的新增提交总数。
  - `{{changedFilesCount}}`：本次变动的源码文件总数。
  - `{{diffSummary}}`：增量变动统计摘要文本。
- 智能体指导语与跨阶段事实：
  - `{{prompt}}`：开箱即用的专业维护指导语，调度器会根据代码仓类型与增量类型动态装配。
  - `{{codePhaseSummary}}`：第一阶段所有已完成巡检的代码仓变更事实汇总。第一阶段执行时该值为空；在第二阶段系统知识库维护时自动注入，为跨仓主流程聚合提供客观事实输入。

---

## 结果看板与结算报告

- 终端实时进度反馈：调度器在运行期间会在控制台实时刷新当前处理进度，直观展示已处理仓库数量、总仓库数量以及当前正在处理的代码仓名称。
- 结算报告（默认保存在 `maintenance-report.md`）：流水线运行结束后自动生成 Markdown 格式的结算审计报告，清晰列出总体指标与各仓库维护结果：

```markdown
# 知识库维护流水线结算报告

- 远端维护视图: skm
- 纳管仓库总数: 3
- 成功闭环数: 2
- 跳过未变动数: 1
- 执行失败数: 0
- 整体总耗时: 185s

## 仓库维护明细

| 仓库名称 | 治理类型 | 目标提交 | 执行状态 | 耗时 | 明细说明 |
|---|---|---|---|---|---|
| order-service | code | 8f3a12b | completed | 95s | 增量核验完成，文档已同步更新并推进检查点 |
| cron-service | code | 3c9d44e | skipped | 2s | 检查点与 HEAD 一致，无变动跳过 |
| system-knowledge | system_knowledge | 5e2a901 | completed | 88s | 系统知识库全局聚合完成，已同步跨仓主流程 |
```
