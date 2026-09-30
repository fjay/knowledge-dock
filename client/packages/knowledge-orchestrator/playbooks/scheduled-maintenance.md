# 定期知识维护流水线标准规程

本文档规范智能体使用 ActionDock 本地编排包进行多代码仓全量巡检、系统知识库全局聚合以及检查点推进闭环的标准操作规程。

## 规程背景与目标

- 核心定位：本地客户端控制平面负责批量多仓三阶段调度，通过内部远程查询与异步派发驱动云端原子维护能力。
- 核心原则：Git 仓库作为正式知识的唯一事实源，检查点推进作为绝对交付标志，三阶段严格按拓扑顺序执行。
- 物理边界隔离：流水线调度器（`orchestrator.pipeline`）属于本地控制平面动作，必须在本地宿主机或本地智能体终端执行，绝不打包进云端容器镜像。

## 前置环境准备与配置

- 本地编排环境确认：ActionDock 运行时处于就绪状态，已将本地编排包链接登记至 ActionDock 全局路由表。
- 远端维护视图配置：本地客户端配置中心已登记远端特权维护视图配置 `skm`。
- 远端仓库清单确认：远端工作区目录存在受纳管代码仓与系统知识仓。

## 标准三阶段调度全景

流水线严格遵循三阶段顺序调度，确保依赖事实完备：

- 第一阶段：单代码仓分支同步与变更核验。依次遍历各业务代码仓，核验代码变更，派发维护智能体进行文档有效性分析与闭环推进。
- 第二阶段：系统知识库全局跨仓聚合核验。在所有代码仓完成核验后，汇总前序代码仓的更新事实，触发系统知识库的新领域识别与跨仓端到端流程聚合。若前序代码仓均无变更且系统知识库基线已对齐，自动跳过系统层维护。
- 第三阶段：排障经验待审池串行核验与消费。拉取全局待审候选文档清单，单实例串行派发维护智能体进行交叉事实核验与知识提炼，轮询待审池移出状态直至消费闭环。

## 流水线动作编排与调用

通过 `orchestrator.pipeline` 一键触发三阶段全自动流水线。

**重要说明**：
`orchestrator.pipeline` 是本地 Action，在本地宿主机或本地智能体终端执行，**命令行绝对不带** `--profile skm` **控制选项**！
参数中的 `profile="skm"` 仅仅作为数据入参在双短横线（`--`）后传递给内部远程查询！

- 预演核验（`dryRun`）：
  - 仅扫描远端变更并渲染派发命令，不实际触发外部任务与检查点轮询。
  - 调用示例：
    ```bash
    ad run orchestrator.pipeline -- profile="skm" dryRun:=true
    ```
- 正式流水线执行：
  - 配置外部智能体派发命令模版，启动异步轮询与三阶段闭环驱动。
  - 派发参数模版：支持 `{{repo}}`、`{{path}}`、`{{branch}}`、`{{from}}`、`{{to}}`、`{{commitCount}}`、`{{changedFilesCount}}`、`{{diffSummary}}`、`{{commitsSummary}}`、`{{codePhaseSummary}}`、`{{candidateId}}`、`{{candidateTitle}}`、`{{candidateFilename}}`、`{{candidatePath}}`、`{{candidateDomain}}` 与 `{{prompt}}` 占位符。
  - 调用示例（配合日志文件落盘）：
    ```bash
    ad run orchestrator.pipeline -- profile="skm" logFile="/var/log/knowledge-pipeline.log" dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"' timeout:=15 interval:=10
    ```
- 单仓限定执行：
  - 使用 `only` 参数聚焦单个或指定仓库列表。
  - 调用示例：
    ```bash
    ad run orchestrator.pipeline -- profile="skm" only="order-service" dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}"'
    ```
- 跳过系统知识库聚合：
  - 使用 `skipSystemKnowledge` 参数仅执行单仓巡检阶段。
  - 调用示例：
    ```bash
    ad run orchestrator.pipeline -- profile="skm" skipSystemKnowledge:=true dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}"'
    ```
- 强制全量维护系统知识库：
  - 使用 `forceSystemKnowledge` 参数在代码仓无变更时强制唤醒智能体执行系统知识库跨仓反查与主流程编排。
  - 调用示例：
    ```bash
    ad run orchestrator.pipeline -- profile="skm" forceSystemKnowledge:=true dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}"'
    ```
- 主动探测并同步系统知识库远端提交：
  - 使用 `syncSystemKnowledge` 参数在前序无更新时主动拉取远端源分支以探测外部新提交并对齐检查点。
  - 调用示例：
    ```bash
    ad run orchestrator.pipeline -- profile="skm" syncSystemKnowledge:=true dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}"'
    ```
- 跳过待审池消费：
  - 使用 `skipInbox` 参数跳过待审池候选文档消费阶段。
  - 调用示例：
    ```bash
    ad run orchestrator.pipeline -- profile="skm" skipInbox:=true dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}"'
    ```

## 实时执行日志观测与流式追踪

针对批量跑批与多仓耗时较长的特性，规程推荐以下四种日志观测与追溯范式：

- 原生参数日志落盘与追踪：
  - 调用动作时传入 `logFile` 参数，流水线调度器将带时间戳的生命周期事件（扫描基线、任务派发、检查点轮询、系统知识库第二阶段触发、完成报告）实时追加写入目标文件。
  - 在终端中执行以下命令实现流式日志跟踪：
    ```bash
    tail -f /var/log/knowledge-pipeline.log
    ```
- 本地后台守护进程执行与流重定向：
  - 生产批处理任务必须在本地宿主机 Shell 中启动守护进程，将标准输出流与标准错误流合并重定向至日志文件：
    ```bash
    nohup ad run orchestrator.pipeline -- profile="skm" dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"' > /var/log/pipeline-stdout.log 2>&1 &
    ```
  - 通过标准命令实时追踪后台输出：
    ```bash
    tail -f /var/log/pipeline-stdout.log
    ```
- 前台控制台交互式流式直读：
  - 开发者在本地终端调试时直接前台执行 `ad run orchestrator.pipeline`。
  - 框架默认将执行日志与进度事件无缓冲实时流式输出至终端控制台，天然具备实时可见性。
- 异步长任务执行凭据状态回溯：
  - 若使用 `ad run orchestrator.pipeline --async` 提交异步任务，命令返回对应的执行标识符。
  - 维护人员可通过专用命令查验事件流与最终明细：
    ```bash
    ad runs show <runId>
    ```

## 异常排查与原子动作手动自愈

若流水线调度中出现局部仓库失败或超时，维护人员可使用云端特权原子动作进行分步自愈：

- 分支同步核验（`maintenance.sync`）：
  - 检查分支合并与远端同步状态，排查工作区未提交修改或合并冲突。
  - 调用示例：
    ```bash
    ad run maintenance/maintenance.sync --profile skm -- path="/srv/workspace/order-service"
    ```
- 差异扫描核验（`maintenance.list`）：
  - 扫描指定仓库自前置检查点以来的新增提交与变动统计。
  - 调用示例：
    ```bash
    ad run maintenance/maintenance.list --profile skm -- path="/srv/workspace/order-service"
    ```
- 文档提交与发布（`maintenance.publish`）：
  - 手动修复文档后，提交知识文档改动并推送至远端分支。
  - 调用示例：
    ```bash
    ad run maintenance/maintenance.publish --profile skm -- path="/srv/workspace/order-service" message="docs: update order payment flow"
    ```
- 检查点水位推进（`maintenance.complete`）：
  - 无论文档是否修改，核验完成后必须显式推进检查点水位至最新提交。
  - 调用示例：
    ```bash
    ad run maintenance/maintenance.complete --profile skm -- path="/srv/workspace/order-service" commit="2222222" actionTaken="docs_updated" summary="更新支付回调说明"
    ```

## 质量门禁与安全红线

- 零断链门禁铁律：修改任何文档后必须执行 `workspace/links.verify` 校验，存在断链时必须立即就地修复至零断链方可交付。
- 纯文档目录收敛：代码仓知识文档严格收敛在 `docs/knowledge/` 目录下，严禁污染或误改业务源码。
- 检查点闭环交付：检查点推进是维护周期的绝对交付标志，未推进检查点视同维护任务未闭环。
- 视图权限划分：查询视图按白名单限制只读检索与受控收集动作；维护视图按包授权开放完整工作区读写、知识收集与维护能力。
