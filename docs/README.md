# Knowledge Dock 文档体系

Knowledge Dock 是为 AI 智能体与研发团队构建的自维护工程知识基础设施。系统以 Git 作为唯一事实源，通过代码变更驱动增量核验，将人工排障经验收敛至待审池缓冲流转，在云端提供权威最新只读视界，实现工程知识的全自动维护与自生长闭环。

---

## 核心设计理念

- **Git 是唯一事实源**：代码与正式知识统一纳管，不设立脱离代码的外部专有数据库；
- **代码变化不等于知识更新**：业务代码变更仅触发核验，唯有对外业务契约与规则失效时才更新文档；
- **人工贡献统一进入待审池**：排障经验与人工补充统一进入审核缓冲区，经源码交叉求证后转正；
- **智能体负责整理维护**：人类工程师提供关键事实证据，智能体承接文档对齐、断链自愈与分支发布的工程开销。

关于四大设计原则的推导与核心术语定义，参见 [docs/concepts.md](concepts.md)。

---

## 文档体系阅读路径

建议根据使用场景与关注维度查阅对应专门文档：

```text
README.md (项目理解入口与总览)
 │
 ├── 为什么需要它？(痛点与为什么不是 RAG) ──────> docs/vision.md
 │
 ├── 核心概念是什么？(四大原则与术语定义) ─────> docs/concepts.md
 │
 ├── 系统如何架构？(逻辑架构与单端口视图) ─────> docs/architecture.md
 │
 ├── 动作底座如何设计？(ActionDock 与硬门禁) ─> docs/action-design.md
 │
 ├── 流程如何流转？(全生命周期与调度时序) ─────> docs/workflow.md
 │
 ├── 文档如何组织？(知识骨架与待审池格式) ─────> docs/knowledge-model.md
 │
 ├── 智能体如何分工？(角色矩阵与协同模型) ─────> docs/agent-design.md
 │
 ├── 系统如何部署？(容器环境与安全边界) ───────> docs/deployment.md
 │
 ├── 日常如何运维？(基线运维与质量门禁) ───────> docs/operations.md
 │
 └── 业务如何演进？(支付超时真实案例复盘) ─────> docs/examples/payment-flow.md
```

各文档定位说明：
- **产品愿景与方案对比**：深入了解项目背景、隐性危机剖析以及与传统 RAG / Wiki 的本质区别，参见 [docs/vision.md](vision.md)；
- **核心概念与设计原则**：查阅四大核心设计原则、单端口虚拟视图、双分支隔离模型与检查点机制权威定义，参见 [docs/concepts.md](concepts.md)；
- **全景架构设计指南**：了解系统核心组件、逻辑架构拓扑、运行时架构与安全边界，参见 [docs/architecture.md](architecture.md)；
- **动作体系与底座工程**：深入理解面向智能体工作空间的第一性原理、ActionDock 基础设施选型推导、单端口虚拟视图与确定性硬门禁机制，参见 [docs/action-design.md](action-design.md)；
- **核心流程与生命周期**：掌握代码变更自维护、待审池流转闭环与三阶段流水线调度机制，参见 [docs/workflow.md](workflow.md)；
- **知识模型与内容组织**：查阅六类标准化知识骨架结构与 Knowledge Inbox 候选标记节规范，参见 [docs/knowledge-model.md](knowledge-model.md)；
- **智能体设计与角色矩阵**：了解贡献守门、特权维护、总控编排与只读排障助手的分工协同，参见 [docs/agent-design.md](agent-design.md)；
- **部署与交付实战指南**：获取多仓库配置、双令牌安全基线、私有 Git 免密连接与 Docker 容器部署指引，参见 [docs/deployment.md](deployment.md)；
- **知识运维与质量门禁**：获取检查点基线运维、待审池流转操作、零断链门禁自愈与日志审计手册，参见 [docs/operations.md](operations.md)；
- **业务演进端到端案例**：通过支付服务新增 `PAY_TIMEOUT` 超时状态驱动多文档联动自演进的完整案例获得直观体验，参见 [docs/examples/payment-flow.md](examples/payment-flow.md)。

---

## 极速上手四步路径

- **连接代码仓库**：在 `server/config/repos.json` 中配置纳管仓库清单与分支对应关系；
- **启动服务容器**：配置 `.env` 鉴权令牌并执行 `docker compose up -d --build` 启动单端口服务；
- **建立初始基线**：在控制平面运行首次增量扫描，建立各仓库检查点基线水位；
- **检索与排障消费**：通过单端口查询视图获取经过代码交叉核验的权威事实视界。

关于完整的部署命令与配置文件说明，参见 [docs/deployment.md](deployment.md)。
