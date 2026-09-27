# 本地流水线编排指南

---

## 执行机物理边界与命令行约束

在执行流水线调度前，请务必明确以下执行机边界与命令行规范：

- 纯本地运行属性：流水线调度器（`orchestrator.pipeline`）属于客户端控制平面的纯本地动作，必须在本地终端或宿主执行机执行，严禁且无需部署至云端容器中运行。
- 命令行控制选项规范：在终端执行调用时，**命令行严禁附加控制选项** `--profile`。
- 作用原理解析：若在命令中附加 `--profile skm`（例如错误编写为 `ad run orchestrator.pipeline --profile skm`），ActionDock 运行时会将调度器自身打包并尝试上传至云端 443 服务端执行。云端容器既未安装调度器的本地运行时依赖，亦无法在内部直接反向派发外部智能体，必然导致执行异常。
- 数据入参区别：参数 `profile="skm"` 仅作为数据入参在双短横线（`--`）之后传入，供调度器在向服务端查询检查点水位时使用。由于其默认值即为 `skm`，常规调用可直接缺省。

正确与错误调用范式对比：

```bash
# 正确调用范例 (命令行无 --profile 控制选项，入参在 -- 之后传递)
ad run orchestrator.pipeline -- dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"'

# 绝对禁止的错误调用反例 (切勿在命令行添加 --profile 控制选项)
# ad run orchestrator.pipeline --profile skm -- dispatchCmd='...'  <-- 严禁添加控制选项
```

---

## 本地编排包链接注册

首次运行流水线调度前，需将本地客户端编排包软链注册至本地全局路由表：

```bash
ad link client/packages/knowledge-orchestrator
```

注册完成后，通过列表命令确认本地已挂载 `orchestrator.pipeline` 动作：

```bash
ad list
```

---

## 四种运维范式

多代码仓批量巡检与知识维护通常需要较长执行周期。根据不同场景，推荐以下四种标准运维范式：

- 单次前台执行：
  在本地终端前台直接运行，实时展示执行阶段与轮询进度，适用于开发调试与单次手动维护：
  ```bash
  ad run orchestrator.pipeline -- \
    dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"'
  ```

- 干跑预演模式（`dryRun`）：
  通过配置 `dryRun:=true` 启用预演模式。调度器仅扫描各仓库代码变动、解析提交差异并输出完整渲染后的派发命令，不实际触发外部智能体调用与检查点推进：
  ```bash
  ad run orchestrator.pipeline -- dryRun:=true
  ```

- 后台守护进程调度（`nohup`）：
  针对多微服务工程批量维护，推荐使用 `nohup` 置于后台守护运行，配合输出重定向与日志持久化，防止终端连接中断导致任务中止：
  ```bash
  nohup ad run orchestrator.pipeline -- \
    logFile="/var/log/knowledge-pipeline.log" \
    dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"' \
    > /var/log/pipeline-stdout.log 2>&1 &
  ```

- 日志流式追踪（`tail -f`）：
  通过 `tail -f` 实时监控调度流水线的结构化日志流，掌握各阶段执行进度：
  ```bash
  tail -f /var/log/knowledge-pipeline.log
  ```

- 定时巡检自动化配置：
  可将调度命令配置至系统 crontab 定时任务中，实现无人值守的自动化定期巡检：
  ```bash
  0 2 * * * ad run orchestrator.pipeline -- logFile="/var/log/knowledge-pipeline.log" dispatchCmd='...'
  ```

---

## 参数配置速查表

在终端执行 `ad run orchestrator.pipeline -- [参数列表]` 时，支持以下配置参数：

| 参数名称 | 类型 | 默认值 | 作用说明 |
|---|---|---|---|
| `dispatchCmd` | 字符串 | 无 | 必填（预演模式除外）。向智能体派发维护任务的命令模板，支持使用占位符动态填充参数 |
| `profile` | 字符串 | `skm` | 服务端特权维护视图配置名称。供调度器向服务端查询检查点水位，默认值为 `skm`，常规调用可缺省 |
| `timeout` | 数值 | `15` | 单仓维护最长等待超时时间（单位为分钟）。超时未完成推进检查点将记录失败并继续处理后续仓库 |
| `interval` | 数值 | `10` | 轮询探测服务端检查点推进状态的时间间隔（单位为秒） |
| `dryRun` | 布尔值 | `false` | 预演模式开关。设为 `true` 时仅打印计算变量与渲染后的派发命令，不实际触发任务 |
| `only` | 字符串 | 空 | 限制仅维护指定的仓库。支持单个仓库名或逗号分隔的仓库列表，如 `only="order-service,payment-service"` |
| `skipSystemKnowledge` | 布尔值 | `false` | 是否跳过第二阶段的全局系统知识库聚合维护 |
| `reportFile` | 字符串 | `maintenance-report.md` | 结算审计报告输出路径，记录各仓库维护结果与耗时指标 |
| `logFile` | 字符串 | 空 | 结构化运行日志追加写入路径，便于使用 `tail -f` 流式追踪 |

---

## 命令模板占位符说明

在配置 `dispatchCmd` 命令模板时，可以使用占位符让调度器动态注入参数。调度器会自动完成引号安全转义，防止命令注入风险：

- 基础信息占位符：
  - `{{repo}}`：当前代码仓目录名称（如 `order-service`）。
  - `{{path}}`：当前仓库在服务端工作区的绝对路径（如 `/srv/workspace/order-service`）。
  - `{{branch}}`：当前仓库的目标分支名（业务代码仓默认为 `release`，系统知识仓默认为 `master`）。
  - `{{repoType}}`：当前仓库治理类型（`code` 或 `system_knowledge`）。
- 提交差异占位符：
  - `{{from}}`：上次检查点记录的代码提交哈希（初次建库时为 `initial`）。
  - `{{to}}`：当前服务端目标分支最新提交哈希。
  - `{{commitCount}}`：待核验的新增提交总数。
  - `{{changedFilesCount}}`：本次变动的源码文件总数。
  - `{{diffSummary}}`：增量代码变动统计摘要文本。
- 智能体指导语与跨阶段事实：
  - `{{prompt}}`：开箱即用的工程维护指导语，调度器依据代码仓类型与增量类型动态装配。
  - `{{codePhaseSummary}}`：第一阶段所有已完成维护的代码仓变更事实汇总。第一阶段执行时该值为空；在第二阶段系统知识库维护时自动注入，为跨仓端到端主流程聚合提供客观事实输入。

---

## 结果看板与结算报告

- 终端实时进度反馈：调度器在运行期间在控制台实时刷新当前处理进度，展示已处理仓库数量、总仓库数量以及当前正在处理的代码仓名称。
- 结算报告（默认保存在 `maintenance-report.md`）：流水线运行结束后自动生成 Markdown 格式的审计报告，汇总运行指标与各仓库维护结果：

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
