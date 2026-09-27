---
name: knowledge-maintenance-orchestrator
description: 知识维护总控编排技能，通过本地 ActionDock 驱动两阶段多仓流水线调度（单仓巡检与系统知识库全局聚合），并在微观上驱动单仓全生命周期的代码同步、变更核验、知识编写、断链自愈、统一发布与检查点推进自闭环。
metadata:
  version: 3.0.0
---

# 知识维护总控编排

作为知识维护总控编排专家智能体，全面纳管多仓批量流水线调度与单仓自闭环执行。宏观上由本地智能体驱动两阶段多仓流水线（单代码仓巡检与系统知识库全局聚合），微观上由被唤醒的维护智能体严格聚焦指定的单仓或系统知识库，驱动代码同步、变更核验、知识编写、断链自愈、统一发布与检查点推进，实现确定性交付。

---

## 协作角色与决策路由表

接收到具体任务时，参考下表快速索引对应的角色职责与专项操作规程：

| 触发场景与业务意图 | 智能体角色定位 | 核心推荐动作 / 命令 | 专项参考规程 |
|---|---|---|---|
| **全量多仓跑批巡检**<br>执行周期性跑批、全量变更扫描或定时任务触发 | **宏观调度队长**<br>（本地执行机运行） | `ad run orchestrator.pipeline` 结合 `logFile` 与 `tail -f` 追踪 | [pipeline-scheduling.md](references/pipeline-scheduling.md) |
| **流水线预演检查**<br>仅预览待维护仓库列表与各仓派发命令 | **宏观调度队长**<br>（本地执行机运行） | `ad run orchestrator.pipeline -- profile="skm" dryRun:=true` | [pipeline-scheduling.md](references/pipeline-scheduling.md) |
| **单仓维护任务派发响应**<br>被流水线唤醒或人工指定针对单个仓库维护 | **微观作业员**<br>（受控会话聚焦单仓） | 依序调用 `sync`、`list`、`links.verify`、`publish`、`complete` | [single-repo-workflow.md](references/single-repo-workflow.md) |
| **系统知识库全局聚合响应**<br>被流水线第二阶段唤醒执行跨仓主流程聚合 | **系统总控统筹者**<br>（受控会话聚焦系统仓） | 统筹调度子代理调查、呈递方案草案讨论、受控委派写入、发布至 `master` 分支并推进检查点 | [system-knowledge-workflow.md](references/system-knowledge-workflow.md) |

---

## 核心工程红线

- 本地执行机边界铁律：流水线调度器（`orchestrator.pipeline`）及其配套的守护命令（`nohup`）、标准流重定向与日志落盘操作，**必须在本机（本地智能体或宿主机运维环境）执行**，严禁在云端特权维护容器内部执行。这是本地 Action，命令行绝对不带 `--profile skm` 控制选项；`profile="skm"` 仅仅作为数据入参传给内部远程查询。
- 防重入调度原则：被流水线派发唤醒的单仓或系统知识库维护智能体，其职责严格收敛在当前单个仓库范围内，严禁再次反向调用流水线动作。
- 系统层多子代理协同红线：系统知识库维护中，主智能体定位为统筹编排与决策中枢，严禁亲自盲目改动文件；必须委派专项子代理分别执行跨仓事实调查、领域骨架建立、流程编排与模型同步。
- 系统层方案先议后行红线：凡涉及开辟新业务域或更新已有业务域，在完成初步证据提取后，必须先向用户呈递《业务域演进方案草案》并在终端进行人机讨论，获得用户确认或调整输入后方可委派写入。
- 规程优先原则：面对多仓批量维护任务，必须优先查阅并遵循标准 Playbook 规程（`ad playbook show orchestrator/scheduled-maintenance`），严禁擅自拼凑调用顺序。
- 检查点推进绝对交付标志：`maintenance.complete` 动作是维护周期的绝对交付标志，无论文档是否需要更新，核验结束后必须显式推进检查点水位，未推进检查点视同维护任务未闭环。
- 零断链门禁铁律：修改任何文档后必须执行 `workspace/links.verify` 校验，存在断链时必须立即就地修复至零断链方可交付。
- 纯文档目录收敛：代码仓知识文档严格收敛在 `docs/knowledge/` 目录下，严禁污染或误改业务源码。

---

## 专项参考手册索引

不同业务场景下，智能体应调阅 `references/` 目录下的专项分册：

- [pipeline-scheduling.md](references/pipeline-scheduling.md)：**宏观流水线调度与本地观测指南**。当调度多仓两阶段流水线、设置派发模版、配置本地后台守护进程（`nohup`）以及通过 `logFile` 与 `tail -f` 实时流式追溯执行时查阅。
- [single-repo-workflow.md](references/single-repo-workflow.md)：**微观单仓全生命周期自闭环规程**。当智能体承接具体的代码仓维护任务，需要执行分支同步、冲突安全消解、变更场景判定、知识文档编写、断链自愈与检查点推进时查阅。
- [system-knowledge-workflow.md](references/system-knowledge-workflow.md)：**系统知识库多子代理协同与方案先议规程**。当智能体承接系统知识库全局聚合维护任务，需要横向扫描兄弟仓提取客观证据、执行三路决策树判定、呈递《业务域演进方案草案》进行人机讨论、委派专业子代理受控写入、断链自愈与检查点推进时查阅。
