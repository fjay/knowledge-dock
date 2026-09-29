# 参考手册：宏观流水线调度与本地观测指南

本文档作为知识维护总控智能体的宏观编排指南，规范多仓三阶段流水线调度、本地执行机边界约束、后台守护进程管理与实时日志追溯操作。

---

## 宏观流水线调度架构与目标

- 核心目标：在大规模微服务与跨仓知识库体系中，通过单一调度动作完成全量业务代码仓的周期性巡检，并在下游触发系统知识库的全局聚合与主干发布。
- 解耦模型：
  - 调度器承担批量循环、依赖拓扑分析、命令模版渲染、异步派发与状态轮询探测；
  - 维护智能体承接单仓具体维护，完成闭环后退出，杜绝上下文长链路累积膨胀；
  - 云端检查点为唯一事实源，天然支持断点续传。

---

## 三阶段依赖拓扑顺序

流水线调度器严格遵循三阶段拓扑先后次序执行，确保事实依据完备：

- 第一阶段（单代码仓巡检）：
  - 依次遍历各个业务代码仓，驱动分支同步、增量核验与知识维护。
  - 推进各业务代码仓检查点水位，并沉淀各仓变更事实摘要清单。
- 第二阶段（系统知识库全局聚合）：
  - 若前序代码仓存在更新或系统知识库本身存在变更，调度器自动唤醒系统知识库维护智能体。
  - 自动注入前序代码仓的更新摘要，驱动新业务领域自动识别、目录初始化与跨仓端到端主流程聚合。
  - 推进系统知识库主分支检查点。
  - 若前序所有代码仓均无变更且系统知识库基线已对齐，自动跳过系统层维护。
- 第三阶段（排障经验待审池串行消费）：
  - 自动通过特权维护视图拉取处于 `pending` 状态的待审候选文档清单。
  - 前置探测与版本收敛：在串行派发前执行待审状态探测，若某篇候选已被初筛或前序终版候选归档移出 pending 列表，自动跳过派发并计入完成，不唤醒外部智能体重复处理。
  - 针对每一份有效候选文档，单实例串行派发维护智能体进行交叉事实核验与知识合入。
  - 周期性轮询待审池清单，直至该候选文档被归档移除或达到超时时限。
  - 若待审池为空或指定跳过，自动跳过消费阶段。

---

## 本地执行机边界铁律（核心约束）

在调度流水线时，智能体与运维人员必须恪守以下执行机物理边界：

- 流水线调度器必须在本机执行：
  - 流水线动作 `ad run orchestrator.pipeline` 属于本地控制平面编排动作，必须在本地运行机（本地智能体所在宿主机或本地终端）执行。
  - 严禁在云端特权维护容器（`skm` 服务端内部）执行该调度命令。
  - 命令行绝对不带 `--profile skm` 控制选项！`profile="skm"` 仅仅作为数据入参在双短横线（`--`）后传给内部远程查询。
- 进程守护命令必须在本机执行：
  - 用于长时跑批脱离终端的 `nohup`、后台运行符 `&` 以及标准输入输出重定向，必须直接在本机操作系统 Shell 中执行。
  - 严禁尝试通过受管终端动作（如 `bash.exec`）将 `nohup` 发送给远端容器执行。
- 远程能力透明连接：
  - 本机执行的 `orchestrator.pipeline` 通过入参 `profile="skm"` 透明连接云端服务（默认监听 443 端口），调度云端各受管能力。

---

## 规程优先决议准则

依据 ActionDock 规程优先原则，在发起批量维护之前，智能体应当查阅标准 Playbook 规程：

```bash
ad playbook show orchestrator/scheduled-maintenance
```

阅读规程正文后，遵循规程要求设置参数并执行流水线。

---

## 模版引擎占位符字典

在派发模版 `dispatchCmd` 中支持使用以下占位符（执行时会自动执行安全引号转义，防止命令注入破裂）：

- `{{repo}}`：目标仓库标识或名称（如 `order-service` 或 `system-knowledge`）。
- `{{path}}`：远端工作区绝对路径（如 `/srv/workspace/order-service`）。
- `{{branch}}`：目标分支名（代码仓默认为 `release`，系统知识仓默认为 `master`）。
- `{{repoType}}`：仓库架构类型（`code` 或 `system_knowledge`）。
- `{{from}}`：前置检查点提交哈希（初始冷启动建库时为 `initial`）。
- `{{to}}`：目标最新提交哈希。
- `{{commitCount}}`：待核验的新增提交总数。
- `{{changedFilesCount}}`：变动文件总数。
- `{{diffSummary}}`：文件变动统计摘要文本。
- `{{commitsSummary}}`：格式化的提交日志摘要文本。
- `{{codePhaseSummary}}`：前序已完成巡检的代码仓摘要与变更清单（在第二阶段自动注入系统知识库）。
- `{{candidateId}}`：待审候选文档全局唯一标识符（如 `20260927-a1b2c3d4`）。
- `{{candidateTitle}}`：待审候选文档标题。
- `{{candidateFilename}}`：待审候选文档文件名。
- `{{candidatePath}}`：待审候选文档相对路径。
- `{{candidateDomain}}`：待审候选文档所属业务域。
- `{{prompt}}`：开箱即用的专业维护指导语模版（自动根据任务类型适配单代码仓、系统知识库或待审候选文档规程）。

---

## 本地执行命令实战范式

以下命令均在本地运行机（宿主机终端）直接执行：

- 预演核验（`dryRun`）：
  - 仅扫描远端变更并渲染各仓派发命令，不实际触发执行与检查点轮询。
  - 调用命令：
    ```bash
    ad run orchestrator.pipeline -- profile="skm" dryRun:=true
    ```
- 正式生产执行（配置日志落盘）：
  - 配置外部智能体派发模版，启动异步轮询与三阶段闭环驱动。
  - 调用命令：
    ```bash
    ad run orchestrator.pipeline -- profile="skm" \
      logFile="/var/log/knowledge-pipeline.log" \
      dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"' \
      timeout:=15 interval:=10
    ```
- 本机后台守护进程执行（使用 `nohup`）：
  - 铁律：必须在本机运行，严禁在远端容器执行。
  - 调用命令：
    ```bash
    nohup ad run orchestrator.pipeline -- profile="skm" \
      logFile="/var/log/knowledge-pipeline.log" \
      dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"' \
      > /var/log/pipeline-stdout.log 2>&1 &
    ```
- 本机实时日志流式追踪：
  - 在本机任意控制台执行以下命令，实时追踪流水线时序生命周期事件：
    ```bash
    tail -f /var/log/knowledge-pipeline.log
    ```
- 定向过滤与可选阶段执行：
  - 仅处理指定仓库：传入 `only="order-service"`。
  - 仅执行代码仓巡检（跳过系统知识库）：传入 `skipSystemKnowledge:=true`。
  - 跳过待审池消费：传入 `skipInbox:=true`。
- 异步模式执行与任务凭据查验：
  - 提交异步长任务：
    ```bash
    ad run orchestrator.pipeline --async -- profile="skm" dispatchCmd='...'
    ```
  - 查验执行快照与历史事件流：
    ```bash
    ad runs show <runId>
    ```
