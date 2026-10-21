---
name: knowledge-maintenance-orchestrator
description: 多仓知识维护流水线调度与总控编排技能。当用户需要执行多代码仓批量跑批巡检、比对全量仓库代码变更、启动本地或后台定时维护流水线、批量源码覆盖补齐、预演派发任务或监控三阶段执行进度时激活此技能。具体单仓文档编写与知识提单时不激活。
metadata:
  version: 3.0.0
---

# 知识维护总控编排

作为知识维护总控编排专家智能体，全面纳管多仓批量流水线调度与单仓自闭环执行。宏观上由本地智能体驱动三阶段多仓流水线（单代码仓增量巡检、系统知识库全局聚合与待审池串行消费），微观上由被唤醒的维护智能体严格聚焦指定的单仓、系统知识库或待审候选文档，驱动代码同步、变更核验、知识编写、断链自愈、统一发布与检查点推进，实现确定性交付。

---

## 协作角色与决策路由表

接收到具体任务时，参考下表快速索引对应的角色职责与专项操作规程：

| 触发场景与业务意图 | 智能体角色定位 | 核心推荐动作 / 命令 | 专项参考规程 |
|---|---|---|---|
| **全量多仓跑批巡检**<br>执行周期性跑批、全量变更扫描或定时任务触发 | **宏观调度队长**<br>（本地执行机运行） | `ad run orchestrator.pipeline` 结合 `logFile` 与 `tail -f` 追踪 | [pipeline-scheduling.md](references/pipeline-scheduling.md) |
| **流水线预演检查**<br>仅预览待维护仓库列表与各仓派发命令 | **宏观调度队长**<br>（本地执行机运行） | `ad run orchestrator.pipeline -- profile="skm" dryRun:=true dispatchCmd='ad run my-agent.dispatch -- repo="{{repo}}" prompt="{{prompt}}"'` | [pipeline-scheduling.md](references/pipeline-scheduling.md) |
| **单仓维护任务派发响应**<br>被流水线唤醒或人工指定针对单个仓库维护 | **微观作业员**<br>（受控会话聚焦单仓） | 依序调用 `sync`、`list`、`links.verify`、`publish`、`complete` | [single-repo-workflow.md](references/single-repo-workflow.md) |
| **系统知识库全局聚合响应**<br>被流水线第二阶段唤醒执行跨仓主流程聚合 | **系统总控统筹者**<br>（受控会话聚焦系统仓） | 统筹全景探索、自主决策规划、受控委派写入、发布至 `master` 分支并推进检查点 | [system-knowledge-workflow.md](references/system-knowledge-workflow.md) |
| **待审经验串行消费响应**<br>被流水线第三阶段唤醒执行候选文档核验 | **待审经验核验员**<br>（受控会话聚焦单候选） | 依序核验源码事实、提炼合入规范目录并调用 `knowledge.archive` 归档 | [pipeline-scheduling.md](references/pipeline-scheduling.md) |

---

## 维护模式

`orchestrator.pipeline` 的 `mode` 为 `incremental`（默认）或 `backfill`。补齐模式复用 `only="repo-a,repo-b"`，按仓库名精确匹配，忽略大小写和前后空白；不提供则处理所有代码仓和系统知识仓。`only` 未命中或含不能处理的仓库时报错，错误仓仍失败。`skipSystemKnowledge` 仍有效，Inbox 始终跳过。

`backfill` 高于无变更跳过和已有文档 `scope` 门槛：代码仓无变更也从源码发现主题并补齐遗漏，保留人工内容与已有有效知识。`only` 仅限定单仓补齐目标，不切断系统层联动；单仓成功后自动把本次文档清单与主题交给受管系统仓定向聚合，只有显式 `skipSystemKnowledge:=true` 才仅补单仓。未配置系统仓且未跳过时报错；全部单仓失败则不派发定向聚合。仅指定系统仓、没有代码仓任务时，才执行系统层全景补齐。

单仓只写本仓 `docs/knowledge/`，系统仓只写目标系统仓，其他仓可只读核验。补齐完成需要新的 `checkpointUpdatedAt` 本次完成记录，旧同 commit 不能提前结束。模板支持 `{{mode}}`，派发需传 `prompt="{{prompt}}"`。这不是自动完整性验收器，不保证全仓知识完整；参数与示例见 [pipeline-scheduling.md](references/pipeline-scheduling.md)。

## 核心工程红线

- 本地执行机边界铁律：流水线调度器（`orchestrator.pipeline`）及其配套的守护命令（`nohup`）、标准流重定向与日志落盘操作，**必须在本机（本地智能体或宿主机运维环境）执行**，严禁在云端特权维护容器内部执行。这是本地 Action，命令行绝对不带 `--profile skm` 控制选项；`profile="skm"` 仅仅作为数据入参传给内部远程查询。
- 防重入调度原则：被流水线派发唤醒的单仓或系统知识库维护智能体，其职责严格收敛在当前单个仓库范围内，严禁再次反向调用流水线动作。
- 系统层多子代理协同红线：系统知识库维护中，主智能体定位为统筹编排与决策中枢，严禁亲自盲目改动文件；必须委派专项子代理分别执行跨仓事实调查、领域骨架建立、流程编排与模型同步。
- 系统层范围与自主推进：全流程自主推进，不等待人工决策。全景任务主动排查未纳管仓与跨仓缺漏；补齐后的 `systemScope="related"` 任务优先遵守本次单仓交接范围，定向核验相关领域，不扩展为无关全仓扫描。
- 规程优先原则：面对多仓批量维护任务，必须优先查阅并遵循标准 Playbook 规程（`ad playbook show orchestrator/scheduled-maintenance`），严禁擅自拼凑调用顺序。
- 检查点推进绝对交付标志：`maintenance.complete` 动作是维护周期的绝对交付标志，无论文档是否需要更新，核验结束后必须显式推进检查点水位，未推进检查点视同维护任务未闭环。
- 零断链门禁铁律：修改任何文档后必须执行 `workspace/links.verify` 校验，存在断链时必须立即就地修复至零断链方可交付。
- 纯文档目录收敛：代码仓知识文档严格收敛在 `docs/knowledge/` 目录下，严禁污染或误改业务源码。

---

## 专项参考手册索引

不同业务场景下，智能体应调阅 `references/` 目录下的专项分册：

- [pipeline-scheduling.md](references/pipeline-scheduling.md)：**宏观流水线调度与本地观测指南**。当调度多仓三阶段流水线、设置派发模版、配置本地后台守护进程（`nohup`）以及通过 `logFile` 与 `tail -f` 实时流式追溯执行时查阅。
- [single-repo-workflow.md](references/single-repo-workflow.md)：**微观单仓全生命周期自闭环规程**。当智能体承接具体的代码仓维护任务，需要执行分支同步、冲突安全消解、变更场景判定、知识文档编写、断链自愈与检查点推进时查阅。
- [system-knowledge-workflow.md](references/system-knowledge-workflow.md)：**系统知识库多子代理协同与全自动自闭环规程**。当智能体承接系统知识库全局聚合维护任务，需要横向扫描兄弟仓提取客观证据、执行全景主动探索、三路决策树自主判定、自主规划并委派专业子代理受控写入、断链自愈与检查点推进时查阅。
