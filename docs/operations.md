# 知识运维规程与质量门禁手册

> 工程知识运维的核心不是被动救火与文档修补，而是通过严密的检查点基线控制、待审池流转机制与确定性质量硬门禁，守护知识库的权威性与代码一致性。

本手册面向日常系统运维人员与维护智能体，聚焦于检查点基线控制、排障经验流转操作、质量硬门禁执行与运行时审计追踪。服务端基于「单端口虚拟视图权限隔离」（Virtual Views）在 443 端口实现细粒度动作暴露隔离，各业务代码仓遵循「双分支隔离治理模型」，由「客户端控制平面」（纯本地控制动作，命令行严禁附加 `--profile` 控制选项）统一调度。

---

## 检查点基线运维实战

统一规范表述为「检查点基线推进机制」（基于提交哈希的增量扫描基准）。

### 检查点基线工作原理

系统在持久化状态数据库 `global.db` 中为每个纳管代码仓维护已完成审计的代码提交哈希水位（`last_knowledge_checked_commit`）。后续调度巡检时仅比对该基线与主干业务分支最新提交之间的增量代码集，以此消除全量重复扫描。

### 推进检查点基线操作

当维护智能体完成代码分析，无论是否触发工程文档更新，均须调用推进动作更新基线水位：

- **触发文档更新时的推进**：
  当代码变动涉及对外契约、业务流转状态或排障规则变迁时，维护智能体完成文档编写与断链自愈后，提交并推进基线：
  ```bash
  ad run maintenance/maintenance.complete --profile skm -- \
    path="/srv/workspace/order-service" \
    commit="c7a1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9" \
    actionTaken="docs_updated" \
    summary="根据最新支付超时业务规则更新 flow 与 rule 目录文档"
  ```

- **无需更新文档时的推进**：
  当代码提交仅包含内部代码重构、变量重命名、注释调整或单元测试用例扩充，并未改变系统对外业务契约时，必须指定 `actionTaken="no_change_needed"` 坚决推进基线：
  ```bash
  ad run maintenance/maintenance.complete --profile skm -- \
    path="/srv/workspace/order-service" \
    commit="c7a1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9" \
    actionTaken="no_change_needed" \
    summary="内部重构与单测补充，未改变对外业务契约"
  ```

### 推进检查点基线的核心因果与技术必然性

无文档变更时推进检查点的技术必要性在于：无论代码变更是否触发文档改动，推进基线均为标记该批次提交已通过完整审计与评估的唯一凭据；若不推进检查点，后续维护将持续对已审计代码重复发起冗余比对与全量扫描，破坏增量闭环收敛性并带来不必要的计算开销。

### 检查点状态异常排查与强制重置

若因宿主机底层存储异常导致检查点基线错乱，运维人员可通过终端进行排查与修复：

- **核查当前各仓基线哈希**：
  在特权维护视图下执行检查点列表动作获取各仓状态：
  ```bash
  ad run maintenance/maintenance.list --profile skm
  ```

- **强制重置检查点基线**：
  若需强制系统对某一仓库重新发起全量增量核验，可通过回退基线提交哈希实现重置：
  ```bash
  ad run maintenance/maintenance.complete --profile skm -- \
    path="/srv/workspace/order-service" \
    commit="<目标回退提交哈希>" \
    actionTaken="baseline_reset" \
    summary="人工重置检查点基线至指定版本"
  ```

---

## 排障经验待审池流转管理

统一规范表述为「排障经验待审池」，规范候选经验结构化采集、特权审查提炼与决议归档留痕闭环。

候选文档是贡献单元而非正式知识存储单元，严禁机械地一文一建。维护智能体必须结合代码仓源码进行交叉核验，将事实提炼归纳合入正式骨架目录（`flow/`、`rule/`、`runbook/` 等）。

### 经验结构化投递入池

一线人员或线上排障助手在只读查询视图（`sk`）下向待审池投递候选文档：

```bash
ad run knowledge/knowledge.collect --profile sk -- \
  filename="marketing-budget-limit" \
  content="---
schema_version: 1
title: budget limit 导致的营销活动过滤
domain: marketing
contribution_type: troubleshooting
knowledge_type: runbook
tags:
  - budget-limit
---

<!-- section:context -->
## 问题背景与现象
营销活动计算过程中用户无法参与抽奖活动。

<!-- section:evidence -->
## 证据链
日志包含错误码 ACT_BUDGET_LMT，关联配置表 budget_threshold 为 0。

<!-- section:findings -->
## 已验证结论
当预算阈值触发时过滤用户活动资格。

<!-- section:candidates -->
## 建议沉淀的知识
在营销活动排障手册补充 ACT_BUDGET_LMT 处理步骤。

<!-- section:unknowns -->
## 未确认事项
未知是否所有子渠道均共享同一阈值。

<!-- section:maintainer -->
## Maintainer 处理记录
"
```

### 待审经验扫描与维护智能体消费

- **查询待审候选清单**：
  在特权维护视图下查询当前积压的候选清单：
  ```bash
  ad run knowledge/knowledge.list --profile skm -- status="pending"
  ```

- **交叉求证与提炼转正**：
  维护智能体调用全文检索与文件读取 Action 查阅业务代码仓源码与既有知识文档，严防虚构事实。求证属实后，将排障要点归纳提炼合入正式知识骨架；

- **决议归档移出待审池**：
  提炼合入完成后，调用归档动作记录决策并移出待审池：
  ```bash
  ad run knowledge/knowledge.archive --profile skm -- \
    id="20260927-a1b2c3d4" \
    resolution="accepted" \
    note="已提炼并合入 marketing-service 的 runbook.md 操作手册中"
  ```

### 待审候选归档决议状态说明表

| 决议状态标识 | 语义说明 | 适用场景 | 对应后续处置动作 |
|---|---|---|---|
| `accepted` | 采纳转正 | 事实核验属实且填补既有知识缺口 | 提炼要点合入正式知识骨架，记录转正归档并移出待审池 |
| `duplicate` | 重复记录 | 候选内容在既有知识库中已有完整准确说明 | 标记重复文档路径，直接归档移出待审池 |
| `insufficient_evidence` | 证据不足 | 关键日志缺失或缺少对端源码支撑，事实存疑 | 暂不合入正式库，留存待一线人员补充凭据后重新投递 |
| `rejected` | 驳回废弃 | 经核实与主干源码事实相悖或属于已废弃历史遗留问题 | 记录驳回技术依据，直接归档移出待审池，阻断知识库污染 |

---

## 质量门禁执行规程

系统通过自动化硬门禁守住知识资产质量与业务代码安全，杜绝依赖概率性提示词。

### 零断链门禁

统一规范表述为「零断链门禁」（`links.verify` 就地自愈）。

在编辑 Markdown 文档时，相对路径拼写偏差或章节标题调整极易导致链接失效。在正式发布提交前，必须强制调用断链校验动作：

```bash
ad run workspace/links.verify --profile skm -- path="/srv/workspace/order-service"
```

- **扫描覆盖范围**：全量校验工作区内所有 Markdown 文档的相对文件引用路径、图片静态资源路径与章节标题锚点；
- **就地自愈要求**：若检测到断链数量大于 0，维护智能体必须对照失效清单就地修正自愈，直到断链数归零方可放行。

### 业务代码防污染红线

统一规范表述为「业务代码防污染红线」（严格收敛在 `docs/knowledge/` 目录）。

知识库自维护的核心安全底线是严禁改动业务源码目录与主干分支。

- **为什么业务代码防污染红线必须强制全量回滚**：AI 维护智能体在解析或调试过程中可能误触或误修业务代码，若防污染红线失守，会导致未经人类测试验证的文档改动或代码污染直接合入代码分支，造成生产事故；强制全量回滚阻断发布，彻底隔绝潜在的代码污染扩散；
- **目录收敛核验**：正式发布前，执行工作区状态核查指令：
  ```bash
  ad run workspace/bash.exec --profile skm -- command="git status --porcelain" cwd="/srv/workspace/order-service"
  ```
- **误改强制回滚指令**：若改动列表中混入任何超出 `docs/knowledge/` 目录的业务代码文件，必须立即中止发布流程并执行强制回滚：
  ```bash
  ad run workspace/bash.exec --profile skm -- command="git restore ." cwd="/srv/workspace/order-service"
  ```

---

## 运维处置命令速查表

| 运维分类 | 运维目标 | ActionDock 处置指令 | 核心参数与行为说明 |
|---|---|---|---|
| 检查点基线运维 | 查询全仓检查点水位 | `ad run maintenance/maintenance.list --profile skm` | 获取所有纳管代码仓当前已核验的提交哈希 |
| 检查点基线运维 | 推进检查点（更新文档） | `ad run maintenance/maintenance.complete --profile skm -- path="..." commit="..." actionTaken="docs_updated" summary="..."` | 标记文档已随代码提交同步更新并推进水位 |
| 检查点基线运维 | 推进检查点（无改动） | `ad run maintenance/maintenance.complete --profile skm -- path="..." commit="..." actionTaken="no_change_needed" summary="..."` | 标记提交已通过完整审计无需改动并坚决推进水位 |
| 检查点基线运维 | 强制重置检查点基线 | `ad run maintenance/maintenance.complete --profile skm -- path="..." commit="..." actionTaken="baseline_reset" summary="..."` | 将基线重置为指定版本触发后续增量重新审计 |
| 待审池流转 | 只读采集排障经验 | `ad run knowledge/knowledge.collect --profile sk -- filename="..." content="..."` | 向排障经验待审池追加结构化候选经验 |
| 待审池流转 | 查询待审候选列表 | `ad run knowledge/knowledge.list --profile skm -- status="pending"` | 获取等待审查消费的候选经验清单 |
| 待审池流转 | 决议归档移出待审池 | `ad run knowledge/knowledge.archive --profile skm -- id="..." resolution="accepted" note="..."` | 记录评审决策并将候选文件移出待审池 |
| 质量门禁执行 | 执行全量零断链校验 | `ad run workspace/links.verify --profile skm -- path="..."` | 核验相对路径与锚点，要求断链数必须归零 |
| 质量门禁执行 | 核验代码防污染状态 | `ad run workspace/bash.exec --profile skm -- command="git status --porcelain" cwd="..."` | 确认工作区变更严格收敛在 `docs/knowledge/` 目录 |
| 质量门禁执行 | 越界改动强制全量回滚 | `ad run workspace/bash.exec --profile skm -- command="git restore ." cwd="..."` | 强制丢弃所有未合规改动，阻断代码污染扩散 |

---

## 运行时日志监控与审计追溯

- **服务访问日志查看**：
  通过宿主机持久化日志目录查看单端口视图路由与访问记录：
  ```bash
  tail -f /data/knowledge/logs/access.log
  ```

- **特权操作审计追溯**：
  所有通过特权维护视图（`skm`）执行的写入、编辑、同步、推进与归档操作，均记录于操作审计日志中，便于追溯维护智能体历史决策轨迹：
  ```bash
  tail -f /data/knowledge/logs/audit.log
  ```

---

## 知识运维总结

整个知识运维与质量门禁规程可以凝练为四句话：

- **检查点基线精确锚定审计边界，坚决推进杜绝冗余扫描。**
- **待审经验作为贡献单元缓冲流转，交叉求证提炼防止知识污染。**
- **零断链硬门禁强制就地自愈，保障知识资产链接高可用。**
- **业务代码防污染红线严禁越界，一旦违规强制全量回滚阻断扩散。**

---

## 延伸阅读导航

- **流水线编排实战指南**：了解三阶段流水线调度拓扑与命令安全渲染机制，参见 [orchestration.md](file:///root/code/knowledge-dock/docs/orchestration.md)；
- **部署与交付实战指南**：获取多仓库配置、双令牌安全基线与 Docker 容器部署指引，参见 [deployment.md](file:///root/code/knowledge-dock/docs/deployment.md)；
- **知识模型与内容组织**：查阅六类标准化知识骨架结构与 Knowledge Inbox 候选标记节规范，参见 [knowledge-model.md](file:///root/code/knowledge-dock/docs/knowledge-model.md)；
- **核心流程与生命周期**：掌握代码变更自维护、待审池流转闭环与三阶段流水线调度机制，参见 [workflow.md](file:///root/code/knowledge-dock/docs/workflow.md)；
- **全景架构设计指南**：了解系统核心组件、逻辑架构拓扑、运行时架构与安全边界，参见 [architecture.md](file:///root/code/knowledge-dock/docs/architecture.md)。
