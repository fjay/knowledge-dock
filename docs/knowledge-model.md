# 知识模型与内容组织规范

> 知识模型不是包罗万象的大全，而是服务于智能体高频检索与低开销审计的六类骨架。通过建立刚性结构切片，将离散的工程事实降维为高信噪比的机器可读语料，彻底终结传统文档因信噪比低下与结构失控导致的智能体推理幻觉。

本文详细阐述知识骨架的分层设计、排障经验待审池的候选格式规范、语义标记节契约，以及人机协同提炼的确定性流转闭环。

---

## 核心工程不变量

系统的知识建模与内容流转建立在三条硬性工程不变量之上，拒绝将信息纯净度寄托于主观自觉：

- 知识骨架切片不变量：知识文档必须严格收敛落入既定的六类标准目录，每类目录具备正交且互不重叠的语义边界与契约判定基准，任何超出边界的离散文档均视为工程噪音予以拦截；
- 候选贡献单元与正式知识单元物理隔离不变量：贡献单元是原材料，正式文档是成品，两者物理隔离。排障经验与人工维护必须先暂存至排障经验待审池，经特权维护智能体结合代码源码交叉求证后方可提炼转正，严禁建立一对一的直通映射；
- 业务代码防污染红线不变量：业务代码防污染红线强制约束知识演进范围，文档改动严格收敛在 `docs/knowledge/` 目录下，严禁在业务源码目录生成临时文件或修改工程代码，违者阻断发布并全量回滚。

---

## 单代码仓知识骨架与多维切片矩阵

在业务代码仓的专属知识分支（`docs`）下，所有正式知识统一存放在 `docs/knowledge/` 目录中，强制划分六类标准化目录骨架：

```text
docs/knowledge/
├── flow/          # 业务时序与核心流转路径
├── module/        # 模块划分、核心组件与技术选型
├── rule/          # 业务规则、前置校验条件与拦截逻辑
├── interface/     # 公开 HTTP 与 RPC 契约及消息队列定义
├── data/          # 核心领域实体、存储模型与枚举定义
└── runbook/       # 应急排障预案、常见错误代码与恢复指南
```

### 知识骨架适用场景与边界对照表

| 骨架类别 | 目录相对路径 | 核心收敛边界 | 契约失效判断依据 | 典型承载载体 |
|---|---|---|---|---|
| 业务时序 | `flow/` | 描述端到端请求流转、状态跃迁与异步消息时序 | 状态机新增状态或转移路径、外部交互调用时序发生实质变更 | Mermaid 时序图与状态转移图 |
| 模块设计 | `module/` | 描述子系统职责划分、核心组件关系与技术选型 | 组件新增重构、依赖拓扑调整或架构分工重大演进 | 模块依赖拓扑与核心组件职责说明 |
| 业务规则 | `rule/` | 沉淀业务维度约束、风控拦截策略与阈值分支 | 前置校验条件增删、风控拦截算法调整或业务判定分支变迁 | 规则判定矩阵与分支约束说明 |
| 接口契约 | `interface/` | 聚焦公开 HTTP、RPC 接口与异步消息载荷定义 | 接口入参出参结构变动、错误码枚举增删或消息主题调整 | 接口契约明细表与字段定义 |
| 数据模型 | `data/` | 记录核心持久化实体、数据表设计与全局枚举语义 | 数据库字段增删改、核心状态枚举扩充或表间关联关系演进 | 实体属性映射与状态机枚举字典 |
| 运维排障 | `runbook/` | 针对明确错误码或高频生产故障的定位与自愈预案 | 异常错误码处理规程建立、重试退避策略调整或线上处置手段升级 | 故障特征、证据链排查清单与恢复指引 |

### 文档命名与组织规范

- 单仓文档命名统一遵循 `{kind}-{topic}.md` 规范，例如 `flow-payment.md`、`rule-refund.md`、`runbook-chargeback.md`；
- 每个知识子目录保持单数名词形式，避免多级嵌套与碎片化小文件，保证检索工具精准命中；
- 相关动作由工作区能力包 [knowledge-workspace](file:///root/code/knowledge-dock/server/packages/knowledge-workspace) 统一提供安全读写支持。

### 系统级跨仓知识骨架

针对多个微服务协同参与的企业级业务，系统在独立的全局知识仓中维护跨仓视界：

- 端到端跨系统业务链路：跨越多个服务的全链路时序拓扑与分布式调用链；
- 全局架构与依赖拓扑：跨服务通信协议、统一网关路由映射与公共基础设施依赖网络。

---

## 排障经验待审池候选规范与语义节契约

排障经验待审池由反馈追加平面能力包 [knowledge-inbox](file:///root/code/knowledge-dock/server/packages/knowledge-inbox) 负责底层存储与受控流转。外部人员或智能体通过单端口虚拟视图权限隔离（Virtual Views）下的只读查询视图投递候选文档，初始状态统一为待审状态（`pending`）。

候选文档采用纯文本 Markdown 格式存储，由两部分刚性结构构成：

- 头部元数据：规范的 YAML Frontmatter；
- 正文内容：固定约定的语义标记节注释。

### Frontmatter 元数据字段规范

| 字段名称 | 类型 | 必填 | 取值范围与约束 | 语义说明 |
|---|---|---|---|---|
| `schema_version` | 整数 | 是 | 固定值 `1` | 候选文档结构版本号 |
| `title` | 字符串 | 是 | 简明扼要，严禁主观情绪词 | 候选经验或维护主题名称 |
| `domain` | 字符串 | 是 | 业务领域标识，如 `payment`、`marketing` | 候选所属的业务域分类 |
| `contribution_type` | 字符串 | 是 | `troubleshooting` 或 `maintenance` | 贡献场景类型：故障排障或日常维护 |
| `knowledge_type` | 字符串 | 是 | `flow`、`module`、`rule`、`interface`、`data`、`runbook` | 建议合入的目标骨架类型 |
| `tags` | 字符串数组 | 是 | 小写连字符标签列表 | 检索与过滤关键词标签 |

### 生产排障候选模板范例

适用于一线技术人员在排查线上故障、日志堆栈告警或异常客诉后提炼的实战经验（`contribution_type: troubleshooting`）：

```markdown
---
schema_version: 1
title: 营销活动预算超限导致资格过滤故障分析
domain: marketing
contribution_type: troubleshooting
knowledge_type: runbook
tags:
  - marketing
  - budget-limit
  - activity
---

<!-- section:context -->
## 问题背景与现象

在生产环境大促期间，部分高价值用户请求返回活动未命中。监控报警显示营销资格校验服务耗时突增，客诉反馈高优先级活动无法正常生效。

<!-- section:evidence -->
## 证据链

- 生产日志堆栈：`ActivityFilterService.java:142` 抛出 `BudgetExceededException: Daily budget limit reached: act_88291`；
- 链路追踪标识：`trace_id: 4b29c011e8a9f310`；
- 关键入参：`userId=99823101, activityId=act_88291, channel=APP_STORE`；
- 数据库状态：活动预算表 `act_budget` 中字段 `used_amount` 大于等于 `max_limit`。

<!-- section:findings -->
## 已验证结论

营销引擎在加载活动判定规则时，优先校验全局日预算阈值。当活动日预算耗尽时，系统执行阻断策略，并不会降级遍历备用活动池，导致后续所有规则判定被短路跳过。

<!-- section:candidates -->
## 建议沉淀的知识

- 在 `docs/knowledge/rule/rule-marketing.md` 中补充预算耗尽短路拦截规则；
- 在 `docs/knowledge/runbook/runbook-marketing.md` 中新增预算超限排查与动态调额操作预案。

<!-- section:unknowns -->
## 未确认事项

未查明当多渠道并发扣减预算时，分布式锁争抢失败是否会触发偶发超时告警，需结合对端支付网关源码求证。

<!-- section:maintainer -->
## Maintainer 处理记录
```

### 日常维护候选模板范例

适用于依据最新架构设计方案、跨系统对齐会议或人工补充业务事实的场景（`contribution_type: maintenance`）：

```markdown
---
schema_version: 1
title: 快捷支付签约与扣款端到端主流程补充
domain: payment
contribution_type: maintenance
knowledge_type: flow
tags:
  - payment-sign
  - payment-deduct
---

<!-- section:context -->
## 维护背景

为满足新渠道合规要求，支付中枢升级了快捷支付签约与代扣一体化流程，需在正式知识库中补全完整的状态跃迁与异步消息时序。

<!-- section:content -->
## 建议内容

补充快捷支付签约协议核验、双因子短信鉴权与渠道扣款的时序图及核心分支定义，明确超时冲正状态机。

<!-- section:evidence -->
## 依据

- 渠道接口对接规范版本号：`v3.2.0`；
- 涉及工程类文件：`com.example.payment.service.ContractSignService`；
- 核心数据库表定义：`pay_contract` 与 `pay_transaction`。

<!-- section:target -->
## 建议归属

建议合入 `payment-core` 仓库的 `docs/knowledge/flow/flow-payment-sign.md`。

<!-- section:unknowns -->
## 未确认事项

短信重发窗口期的频控时间间隔尚未在渠道文档中明确，待与渠道技术支持确认。

<!-- section:maintainer -->
## Maintainer 处理记录
```

### 语义标记节契约对比表

| 标记节标识 | 核心语义定位 | 贡献者录入约束 | 维护智能体审计核验要点 |
|---|---|---|---|
| `<!-- section:context -->` | 问题背景与触发上下文 | 描述故障发生环境、受影响服务接口与业务现象 | 确认背景真实性，过滤非公共价值的个人本地偶发问题 |
| `<!-- section:evidence -->` | 客观事实证据链 | 必须提供日志堆栈、调用链标识、真实入参或数据库字段 | 严格核查证据链，严禁主观推测臆断与无依据推论 |
| `<!-- section:findings -->` | 经过验证的技术结论 | 阐明导致异常的直接根因与验证逻辑 | 结合代码仓源码进行交叉比对，验证结论的普遍正确性 |
| `<!-- section:content -->` | 拟补充的正文内容 | 适用于维护场景，提供 Markdown 文本、表格或时序图 | 评估内容与既有知识体系的融合度，提炼为稳定规则 |
| `<!-- section:candidates -->` | 建议沉淀的知识方向 | 指出拟修改或新增的具体知识骨架目录 | 判定建议归属是否准确，杜绝机械一对一建档 |
| `<!-- section:target -->` | 建议归属的目标仓库与路径 | 给出具体仓库标识与相对文件路径建议 | 校验目标文件是否存在，规划打补丁合入方案 |
| `<!-- section:unknowns -->` | 未确认事项与边界留白 | 忠实记录未完全摸清的边缘分支与缺少对端源码事项 | 保留不确定信息，严禁为了形式完整而盲目脑补 |
| `<!-- section:maintainer -->` | 维护人员与智能体处理记录 | 贡献者必须保持留白，由维护平面写入 | 记录合入的目标文件路径、采纳决议与审查意见 |

### 候选文档设计原则

- 保存事实不保存思维链：候选文档的核心价值在于故障的客观现象、核心日志堆栈与确证的代码实现。坚决剔除定位过程中的主观猜测、心理历程与无效尝试，只保留经过验证的技术事实；
- 保留未确认事项严禁主观臆造：排障中遇到因缺少对端源码或缺乏环境复现条件的分支，必须如实记录在未确认事项节中，严禁为了文档结构完整性而凭空捏造未验证逻辑；
- 待审池保存具体案例而正式库保存稳定规则：待审池负责保存具体的故障案例、偶发日志、订单号与局部配置片段；正式知识库仅沉淀长期稳定的通用流程、接口契约、排障预案与全局规则。维护智能体负责将具体案例提炼升华，严禁直接照搬原始案例。

---

## 人机协同准则与消费提炼闭环

系统的核心人机协作理念明确划分为两句话：

> 人类提供事实证据，智能体负责工程对齐。
> 贡献单元是原材料，正式文档是成品，两者物理隔离。

在客户端控制平面（纯本地控制动作，命令行严禁附加 `--profile` 控制选项）的调度编排下，维护智能体 [project-knowledge-maintainer](file:///root/code/knowledge-dock/skills/project-knowledge-maintainer) 串行消费排障经验待审池，必须严格坚守以下消费提炼铁律：

- 严禁机械一对一建档：候选文档是贡献单元，不是正式知识存储单元。严禁机械地为每一篇候选文档新建一个正式知识文件；
- 源码交叉求证：维护智能体必须调取目标代码仓的源码进行比对（调用工作区全文检索 [search-rg.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/search-rg.ts) 与分段读取 [files-read.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-read.ts)），确证候选结论与当前工程实现一致；
- 提炼合入既有骨架：将核验属实的内容作为精准补丁，合入既有的标准目录文件（如将错误码应对手段合入 `runbook/` 下对应文档，将时序更新合入 `flow/` 下时序文档）；
- 决议归档留痕收敛：处理完毕后，维护智能体调用特权归档动作 [knowledge-archive.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-archive.ts) 标记决议（`accepted`、`duplicate`、`insufficient_evidence`、`rejected`），将候选移入归档目录，保证待审池流转收敛无积压。

### 质量门禁与基线闭环保障

在完成知识骨架更新后，系统通过多道刚性质量门禁与安全协议保障交付可靠性：

- 零断链门禁校验：调用 [links-verify.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/links-verify.ts)（`links.verify` 动作）全面扫描文档内的相对链接与锚点完整性，发现失效引用就地自愈，断链统计归零后方可放行；
- 业务代码防污染红线核验：严格核查 Git 暂存区文件清单，确认改动完全收敛在 `docs/knowledge/` 目录下，业务代码源码无任何改动；
- 双分支隔离治理模型协同：主干业务分支与知识分支解耦，遇冲突安全中止并由智能体进行语义消解；
- 检查点基线推进机制保障：调用维护完成动作 [maintenance-complete.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-complete.ts) 推进检查点水位。无文档变更时推进检查点的技术必要性在于：无论代码变更是否触发文档改动，推进基线均为标记该批次提交已通过完整审计与评估的唯一凭据；若不推进检查点，后续维护将持续对已审计代码重复发起冗余比对与全量扫描，破坏增量闭环收敛性并带来不必要的计算开销。

---

## 知识模型总结

本规范的内容与流转架构可以凝练为四句话：

- 知识骨架以六类严格切片收敛，杜绝文档随意滋生与结构膨胀。
- 待审池作为物理缓冲区隔离未审原料，正式文档作为唯一成品受控输出。
- 人类工程师提供一手客观证据，维护智能体完成源码对齐与精准提炼。
- 检查点基线与质量门禁双向锁死，确保知识中枢与业务代码同频演进。

---

## 延伸阅读导航

- 智能体体系设计与角色矩阵：深入了解多智能体协同分工与最小特权视界划分，参见 [docs/agent-design.md](file:///root/code/knowledge-dock/docs/agent-design.md)；
- 业务演进实战案例：查阅支付超时状态驱动的完整自维护实操复盘，参见 [docs/examples/payment-flow.md](file:///root/code/knowledge-dock/docs/examples/payment-flow.md)；
- 全景架构设计指南：了解双平面职责、单端口虚拟视图与支撑系统运转的不变量，参见 [docs/architecture.md](file:///root/code/knowledge-dock/docs/architecture.md)；
- 核心概念与设计原则：查阅四大设计原则与专业术语权威定义，参见 [docs/concepts.md](file:///root/code/knowledge-dock/docs/concepts.md)。
