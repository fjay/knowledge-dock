# 知识运维规程与质量门禁指南

本指南面向日常系统运维人员与维护智能体，聚焦于检查点基线管理、待审池流转操作、质量门禁执行与运行时故障排查。

关于端到端知识流转生命周期，参见 [docs/workflow.md](workflow.md)。

---

## 检查点基线运维实战

### 检查点基线工作原理

检查点基线是系统增量核验的核心锚点。系统在持久化状态数据库 `global.db` 中为每个纳管仓库维护当前已完成审计的提交哈希（`last_knowledge_checked_commit`）。后续调度巡检时仅比对该基线与主干分支最新提交之间的增量代码集。

### 推进检查点基线操作

当维护智能体完成代码分析，无论是否触发工程文档更新，均须调用推进动作更新基线水位：

- **触发文档更新时的推进**：
  ```bash
  ad run maintenance/maintenance.complete --profile skm -- \
    path="/srv/workspace/order-service" \
    commit="c7a1b2d3e4f5..." \
    actionTaken="docs_updated" \
    summary="根据最新支付超时业务规则更新 flow 与 rule 目录文档"
  ```
- **无需更新文档时的推进**：
  当提交仅包含内部代码重构或单元测试用例扩充时，必须指定 `actionTaken="no_change_needed"` 坚决推进基线：
  ```bash
  ad run maintenance/maintenance.complete --profile skm -- \
    path="/srv/workspace/order-service" \
    commit="c7a1b2d3e4f5..." \
    actionTaken="no_change_needed" \
    summary="内部重构与单测补充，未改变对外业务契约"
  ```

推进检查点的技术必要性在于确立增量扫描基准。若不推进基线，后续巡检将持续对已审计代码重复发起冗余扫描与无效比对，破坏系统的增量收敛性。关于失效判定准则，参见 [docs/concepts.md](concepts.md)。

### 检查点状态异常排查与重置

若因宿主机异常断电或存储损坏导致检查点基线错乱，运维人员可通过终端进行排查与修复：

- **核查当前基线哈希**：
  在特权维护视图下执行检查点列表动作获取各仓状态：
  ```bash
  ad run maintenance/maintenance.list --profile skm
  ```
- **重置检查点基线**：
  若需强制系统对某一仓库重新发起全量增量核验，可通过置空或回退基线提交哈希实现重置：
  ```bash
  ad run maintenance/maintenance.complete --profile skm -- \
    path="/srv/workspace/order-service" \
    commit="<目标回退提交哈希>" \
    actionTaken="baseline_reset" \
    summary="人工重置检查点基线至指定版本"
  ```

---

## Knowledge Inbox 待审池流转管理

Knowledge Inbox 是外部人工经验与排障事实的受控缓冲区。关于标准候选文档结构与标记节规范，参见 [docs/knowledge-model.md](knowledge-model.md)。

### 经验结构化投递入池

一线人员或排障助手在只读查询视图（`sk`）下即可向待审池投递候选文档：

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

- **查询待审清单**：
  在特权维护视图下查询当前积压的候选清单：
  ```bash
  ad run knowledge/knowledge.list --profile skm -- status="pending"
  ```
- **智能体交叉求证与提炼转正**：
  候选文档是贡献单元，不是正式知识存储单元，严禁机械地一文一建。维护智能体必须结合代码仓源码进行交叉核验，将事实提炼归纳合入正式骨架目录（`flow/`、`rule/`、`runbook/` 等）；
- **决议归档移出待审池**：
  提炼合入完成后，调用归档动作记录决策并移出待审池：
  ```bash
  ad run knowledge/knowledge.archive --profile skm -- \
    id="20260927-a1b2c3d4" \
    resolution="accepted" \
    note="已提炼并合入 marketing-service 的 runbook.md 操作手册中"
  ```
  归档决议状态说明：
  - `accepted`：事实核验属实且填补知识缺口，已提炼合入正式库；
  - `duplicate`：记录内容在现有知识库中已有完整准确说明；
  - `insufficient_evidence`：关键证据不足或缺少对端源码支撑，暂不入库；
  - `rejected`：经核实与主干源码事实相悖或属于已废弃遗留问题。

---

## 质量门禁执行规程

### 零断链门禁

在编辑 Markdown 文档时，路径拼写偏差或章节标题调整极易导致链接失效。

- **门禁执行指令**：
  在正式发布提交前，必须强制调用断链校验动作：
  ```bash
  ad run workspace/links.verify --profile skm -- path="/srv/workspace/order-service"
  ```
- **扫描覆盖范围**：自动校验工作区内所有 Markdown 文档的相对文件引用路径、图片静态资源路径与章节标题锚点；
- **就地自愈要求**：若检测到断链数量大于 0，维护智能体必须对照失效清单就地修正自愈，直到断链数为 0 方可放行。

### 业务代码防污染红线

知识库自维护的核心安全底线是严禁改动业务源码目录与主干分支。

- **目录收敛核验**：正式发布前，执行工作区状态核查指令：
  ```bash
  ad run workspace/bash.exec --profile skm -- command="git status" cwd="/srv/workspace/order-service"
  ```
- **误改应急回滚**：若改动列表中混入任何超出 `docs/knowledge/` 目录的业务文件，必须立即中止发布流程并执行强制回滚：
  ```bash
  ad run workspace/bash.exec --profile skm -- command="git restore ." cwd="/srv/workspace/order-service"
  ```

---

## 运行时日志监控与审计追溯

- **服务访问日志查看**：
  通过宿主机持久化日志目录查看单端口视图路由与访问记录：
  ```bash
  tail -f /data/knowledge/logs/access.log
  ```
- **特权操作审计追溯**：
  所有通过特权维护视图（`skm`）执行的写入、同步、推进与归档操作，均记录于操作审计日志中，便于追踪维护智能体历史决策轨迹：
  ```bash
  tail -f /data/knowledge/logs/audit.log
  ```
