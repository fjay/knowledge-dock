# Knowledge Dock 文档体系

> Knowledge Dock 的核心使命不是建造又一座静止泛黄的文档孤岛，而是为研发团队与 AI 智能体打造一套与代码提交共生演进的自动化知识基础设施。

本总览文档作为知识中枢的统一导航入口，系统梳理核心工程原则、专业术语映射、文档体系架构以及极速上手指引。

---

## 核心工程原则与事实约束

系统运转建立在客观工程规律与物理约束之上，坚决拒绝依赖不可控的概率性假设：

- **Git 是唯一事实源**：代码与正式工程知识统一纳管于 Git 版本库中，不设立脱离代码的外部独立专有数据库。知识演进与代码提交哈希强绑定，保证历史事实可追溯与可复现；
- **代码变化只是审查信号，契约失效才是更新理由**：业务代码提交仅触发自动化增量核验。内部重构、性能调优或单测补充等未打破对外业务契约的变更，坚决不修改业务文档；
- **双分支隔离治理模型**：统一规范表述为「双分支隔离治理模型」，主干业务分支与知识分支解耦，遇冲突安全中止并由智能体进行语义消解；
- **检查点基线推进机制**：统一规范表述为「检查点基线推进机制」（基于提交哈希的增量扫描基准）。无文档变更时推进检查点的技术必要性在于：无论代码变更是否触发文档改动，推进基线均为标记该批次提交已通过完整审计与评估的唯一凭据；若不推进检查点，后续维护将持续对已审计代码重复发起冗余比对与全量扫描，破坏增量闭环收敛性并带来不必要的计算开销。
- **排障经验待审池缓冲流转**：统一规范表述为「排障经验待审池」，规范候选经验结构化采集、特权审查提炼与决议归档留痕闭环。候选单元是贡献单元而非正式知识单元，严禁机械地一文一建，必须经源码交叉核验提炼后合入正式骨架；
- **单端口虚拟视图权限隔离**：统一规范表述为「单端口虚拟视图权限隔离」（Virtual Views），基于只读查询令牌 `ACTIONDOCK_TOKEN` 与特权维护令牌 `ACTIONDOCK_AGENT_TOKEN` 在 443 端口实现细粒度动作暴露隔离，从底层免除前置反向代理网关；
- **客户端控制平面编排**：统一规范表述为「客户端控制平面」（纯本地控制动作，命令行严禁附加 `--profile` 控制选项），彻底区分全局控制选项 `--profile` 与数据入参 `profile="skm"`，服务端仅保留纯粹轻量的原子 Action；
- **确定性质量硬门禁**：统一规范表述为「零断链门禁」（`links.verify` 就地自愈）与「业务代码防污染红线」（严格收敛在 `docs/knowledge/` 目录）。断链未自愈或改动溢出文档目录时强制阻断并全量回滚。

---

## 文档体系全景架构与阅读路径

```text
README.md (知识库总览与导航入口)
 │
 ├── 方案对比与项目初衷 ──────> docs/vision.md
 │
 ├── 核心概念与设计原则 ──────> docs/concepts.md
 │
 ├── 逻辑架构与安全边界 ──────> docs/architecture.md
 │
 ├── Action 体系与硬门禁 ──────> docs/action-design.md
 │
 ├── 全生命周期流转机制 ──────> docs/workflow.md
 │
 ├── 知识骨架与待审池格式 ────> docs/knowledge-model.md
 │
 ├── 智能体角色分工矩阵 ──────> docs/agent-design.md
 │
 ├── 流水线编排实战指南 ──────> docs/orchestration.md
 │
 ├── 部署交付与免密连接 ──────> docs/deployment.md
 │
 ├── 知识运维与门禁手册 ──────> docs/operations.md
 │
 └── 业务演进端到端案例 ──────> docs/examples/payment-flow.md
```

### 文档定位与受众对照表

| 文档名称 | 对应文件路径 | 核心受众 | 解决的核心问题与技术定位 |
|---|---|---|---|
| 方案对比与初衷 | [vision.md](file:///root/code/knowledge-dock/docs/vision.md) | 架构师、技术决策者 | 阐明为什么不是传统 RAG 或静态 Wiki，剖析传统工程知识失修的隐性危机 |
| 核心概念与原则 | [concepts.md](file:///root/code/knowledge-dock/docs/concepts.md) | 全体研发人员与维护人员 | 建立四大工程设计原则与系统核心概念权威定义 |
| 全景架构设计 | [architecture.md](file:///root/code/knowledge-dock/docs/architecture.md) | 系统架构师、安全工程师 | 阐述服务端事实平面与客户端控制平面划分、单端口虚拟视图与五条硬性不变量 |
| 动作底座体系 | [action-design.md](file:///root/code/knowledge-dock/docs/action-design.md) | 平台工程师、智能体开发者 | 深入解析面向智能体的 Action 接口设计、传统终端选型反推与确定性系统硬门禁 |
| 全生命周期流转 | [workflow.md](file:///root/code/knowledge-dock/docs/workflow.md) | 流程设计师、智能体架构师 | 详解代码变更驱动自维护、待审经验缓冲消费与三阶段调度流转时序 |
| 知识内容模型 | [knowledge-model.md](file:///root/code/knowledge-dock/docs/knowledge-model.md) | 文档维护者、内容贡献者 | 规范六类标准化工程知识骨架目录结构与 Knowledge Inbox 候选文档标记节 |
| 智能体分工协同 | [agent-design.md](file:///root/code/knowledge-dock/docs/agent-design.md) | 智能体开发者、Prompt 工程师 | 明确贡献守门、特权维护、总控编排与只读助手四类智能体的权责与协同机制 |
| 流水线编排指南 | [orchestration.md](file:///root/code/knowledge-dock/docs/orchestration.md) | 运维工程师、流水线开发者 | 阐述客户端控制平面纯本地运行机制、三阶段拓扑、双重转义与生产执行范式 |
| 部署与交付实战 | [deployment.md](file:///root/code/knowledge-dock/docs/deployment.md) | SRE 运维、系统管理员 | 提供单端口虚拟视图免网关部署、宿主机持久化规划、私有 Git 免密连接安全模型与排障速查 |
| 运维规程与门禁 | [operations.md](file:///root/code/knowledge-dock/docs/operations.md) | 日常运维人员、运维智能体 | 提供检查点基线推进操作、待审池流转管理、零断链自愈与业务代码防污染回滚手册 |
| 业务演进案例 | [examples/payment-flow.md](file:///root/code/knowledge-dock/docs/examples/payment-flow.md) | 业务研发、全体协作者 | 通过真实支付服务新增超时状态驱动多文档联动自演进全过程提供沉浸式参考 |

---

## 核心专业术语表述红线与概念映射表

| 规范专业术语 | 英文对照 / 概念标识 | 核心工程定义与不可逾越红线 |
|---|---|---|
| 单端口虚拟视图权限隔离 | Virtual Views | 基于只读查询令牌 `ACTIONDOCK_TOKEN` 与特权维护令牌 `ACTIONDOCK_AGENT_TOKEN` 在 443 端口实现细粒度动作暴露隔离，原生免除前置网关 |
| 双分支隔离治理模型 | Dual-Branch Isolation | 主干业务分支与知识分支解耦，遇冲突安全中止并由智能体进行语义消解，杜绝自动化程序私自篡改业务代码 |
| 检查点基线推进机制 | Checkpoint Baseline Advancement | 基于提交哈希的增量扫描基准。无文档变更时推进检查点的技术必要性在于：无论代码变更是否触发文档改动，推进基线均为标记该批次提交已通过完整审计与评估的唯一凭据；若不推进检查点，后续维护将持续对已审计代码重复发起冗余比对与全量扫描，破坏增量闭环收敛性并带来不必要的计算开销。 |
| 排障经验待审池 | Troubleshooting Inbox | 规范候选经验结构化采集、特权审查提炼与决议归档留痕闭环。候选单元是贡献单元而非正式知识单元，严禁机械映射 |
| 客户端控制平面 | Client Control Plane | 纯本地控制动作，命令行严禁附加 `--profile` 控制选项。彻底区分全局控制选项 `--profile` 与数据入参 `profile="skm"` |
| 零断链门禁 | Zero Broken Links Gate | `links.verify` 就地自愈。正式发布前全量校验相对文件路径、图片与章节锚点，断链数必须归零方可放行 |
| 业务代码防污染红线 | Codebase Pollution Prevention | 严格收敛在 `docs/knowledge/` 目录。正式发布前核验工作区状态，一旦改动超出知识文档目录立即强制全量回滚阻断发布 |

---

## 极速上手路径

- **配置纳管仓库清单**：
  在宿主机 `$KNOWLEDGE_DATA_DIR/config/repos.json` 中配置业务代码仓与系统知识仓清单，明确指定主干业务分支与专属知识分支；
- **启动单端口服务容器**：
  在工程根目录配置 `.env` 中的强随机互斥令牌，执行 `docker compose up -d --build`，自举完成 443 端口单端口多视图服务启动；
- **执行客户端控制平面预演**：
  在客户端执行机软链编排包后，执行 `ad run orchestrator.pipeline -- dryRun:=true` 验证全仓检查点水位与命令模板渲染；
- **发起端到端维护与消费**：
  运行正式流水线完成首轮审计与检查点基线确立，外部开发人员与排障助手即可通过查询视图（`sk`）安全检索权威工程事实并追加排障经验。

---

## 文档体系设计总结

整个 Knowledge Dock 文档体系与工程架构可以凝练为四句话：

- **以 Git 为单一事实源，让工程知识与代码提交原子绑定。**
- **单端口划分双重视界，最小特权保障安全防线。**
- **客户端控制平面编排流水线，检查点机制驱动增量收敛。**
- **确定性质量门禁严防污染，以受控系统驾驭概率性智能体。**

---

## 核心文档直达

- [流水线编排实战指南](file:///root/code/knowledge-dock/docs/orchestration.md)
- [部署与交付实战指南](file:///root/code/knowledge-dock/docs/deployment.md)
- [知识运维与质量门禁手册](file:///root/code/knowledge-dock/docs/operations.md)
- [全景架构设计指南](file:///root/code/knowledge-dock/docs/architecture.md)
- [动作体系设计指南](file:///root/code/knowledge-dock/docs/action-design.md)
- [核心概念与设计原则](file:///root/code/knowledge-dock/docs/concepts.md)
- [核心流程与生命周期](file:///root/code/knowledge-dock/docs/workflow.md)
- [知识模型与内容组织](file:///root/code/knowledge-dock/docs/knowledge-model.md)
- [智能体设计指南](file:///root/code/knowledge-dock/docs/agent-design.md)
- [产品愿景与方案对比](file:///root/code/knowledge-dock/docs/vision.md)
- [业务演进端到端案例](file:///root/code/knowledge-dock/docs/examples/payment-flow.md)
