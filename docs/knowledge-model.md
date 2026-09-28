# 知识格式

正式知识回答“当前系统如何运行”，待审候选记录“有人发现了什么、证据是什么”。两者用途不同：一个候选可以补充多篇文档，也可能与已有知识重复或因证据不足而不被采纳。

## 正式知识的目录

业务代码仓的知识分支使用以下布局。文件名采用 `{kind}-{topic}.md`，其中 `kind` 与所在目录一致，`topic` 使用稳定的业务术语。

```text
docs/knowledge/
├── index.md
├── overview.md
├── flow/
├── module/
├── rule/
├── interface/
├── data/
└── runbook/
```

| 位置 | 应回答的问题 |
|---|---|
| `index.md` | 从业务入口、错误码或技术线索应读哪篇文档？ |
| `overview.md` | 本仓负责什么，与上下游的边界在哪里？ |
| `flow/` | 请求、状态和消息如何流转？ |
| `module/` | 模块职责与内部依赖如何划分？ |
| `rule/` | 哪些判定、计算和准入条件决定业务结果？ |
| `interface/` | HTTP、RPC、事件和任务交接的对外契约是什么？ |
| `data/` | 关键数据对象、状态和归属如何理解？ |
| `runbook/` | 出现特定症状时如何定位、处置与验证恢复？ |

例如，支付状态流转可放在 `flow/flow-payment-state.md`，退款判定放在 `rule/rule-refund.md`。知识是否需要更新，取决于这些内容是否被代码变更推翻，而不是提交次数。

仓库层的 `data/data-databases.md` 只保存所用数据库及数据源的轻量索引。完整 DDL 快照统一放在系统知识仓，避免多个业务仓复制出不一致的表结构。跨仓布局、文件元数据和迁移规则以[维护技能的布局规范](../skills/project-knowledge-maintainer/references/layout.md)为准。

## 候选经验的格式

待审池接收 Markdown 内容。建议使用 YAML 头部记录主题、领域、贡献类型、知识类型、标签和相关仓库；正文用语义标记区分证据与建议。`knowledge.collect` 目前只要求 `content` 为非空文本，不会替贡献者验证这些字段或结论，因此格式校验和查重属于贡献与维护规程。

常用字段：

| 字段 | 含义 |
|---|---|
| `schema_version` | 候选格式版本，当前使用 `1` |
| `title`、`domain` | 主题与业务领域 |
| `contribution_type` | `troubleshooting` 或 `maintenance` |
| `knowledge_type` | 建议归属的六类知识之一 |
| `tags`、`repos` | 检索标签与相关仓库名 |

服务端接收后生成 `id`、`created_at` 和初始 `status: pending`。贡献者无需填写这些字段。

下面是一份精简的排障候选。证据应使用脱敏日志、代码路径、配置或复现结果；无法核实的内容留在“未确认事项”。

~~~markdown
---
schema_version: 1
title: 支付超时后收到延迟回调
domain: payment
contribution_type: troubleshooting
knowledge_type: runbook
tags:
  - payment-timeout
  - callback
repos:
  - payment-service
---

<!-- section:context -->
## 问题背景与现象
订单已超时关闭，随后收到渠道扣款成功回调。

<!-- section:evidence -->
## 证据链
- 脱敏日志中的订单状态、回调时间和渠道流水号。
- 回调处理逻辑的代码路径与提交哈希。

<!-- section:findings -->
## 已验证结论
记录已由源码或复现结果确认的状态转移。

<!-- section:candidates -->
## 建议沉淀的知识
核对现有支付排障手册，并补充延迟回调的处置路径。

<!-- section:unknowns -->
## 未确认事项
渠道侧回调重试次数尚未核实。

<!-- section:maintainer -->
## 处理记录
~~~

日常维护候选使用 `section:content` 记录建议内容、`section:target` 记录建议归属；其余证据与未确认事项仍应保留。完整模板见[贡献技能模板](../skills/knowledge-contributor/references/templates.md)。

## 从候选到正式知识

贡献助手在投递前检索正式知识并等待提交者确认。维护智能体读取候选后核对源码和现有文档，提炼稳定规则，再决定采纳、重复、驳回或证据不足。处理完成后通过 `knowledge.archive` 归档；归档只记录决议，不会自动编辑正式文档。

具体动作见[待审池 README](../server/packages/knowledge-inbox/README.md)，完整流转见[维护流程](workflow.md)。
