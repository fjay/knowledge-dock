# 统一布局与命名规范

所有项目的仓库层知识库与系统层跨项目知识库共用本规范。目标：任何知识库的目录结构、类别名、文件名在所有项目里完全一致、可预测、可机械校验。本规范是硬约束，与项目历史布局冲突时以本规范为准，不为任何单一项目开例外。

## 仓库层布局

固定骨架，不得增删类别目录、不得改名：

```
docs/knowledge/
├── index.md                    # 唯一导航入口，kind: index
├── overview.md                 # 唯一概览，kind: overview，是根目录文件
├── flow/                       # 业务流程
├── module/                     # 模块职责与内部组织
├── rule/                       # 跨流程公共规则
├── interface/                  # 对外契约（HTTP/RPC/事件/CLI/定时任务交接）
├── data/                       # 数据对象与状态；库引用见 data-databases.md
└── runbook/                    # 排障、配置与操作
```

- 类别目录固定为 `flow`、`module`、`rule`、`interface`、`data`、`runbook` 六个，小写单数。禁止复数（`flows/`、`interfaces/`、`modules/`、`rules/`、`runbooks/`），禁止自创类别（`adapter/`、`core/`、`channel/`、`bill/`、`framework/` 等）。业务域差异体现在 topic 与索引中，不体现在目录结构上。
- `index.md` 与 `overview.md` 固定在知识根目录，各只有一份。禁止 `overview/` 目录及 `overview/system-overview.md`、`overview/overview-system.md` 这类变体。
- 每个类别目录内只放该 kind 的 Markdown 文档，不设例外；DDL 材料不进仓库层，统一存系统层（见"DDL 与多生产库"）。
- 知识根目录固定为 `docs/knowledge/`；用户明确指定其他根目录时，内部结构仍按本规范。

## 文件命名

文件名公式：`{kind}-{topic}.md`。

- kind 前缀必填，与所在目录一致；不因"已在类别目录内"而省略——链接和搜索结果必须自解释，文件移动后仍可辨认类别。
- topic：小写 ASCII 字母、数字、连字符，2~5 个词，用稳定业务术语（如 `settlement-order`、`merchant-audit`）；不用日期、版本号、`temp`/`new` 等临时词，不用中文文件名。
- 元数据 id 与文件名一致：`{仓库标识}.{kind}.{topic}`，如 `order-service.flow.order-create`。
- 唯一例外：DDL 文档的 schema 段保留真实库名（可含下划线），见下节。

### 正误对照（左列为历史知识库中实际出现过的违规形态）

| 规范 | 违规形态 |
|---|---|
| `flow/flow-settlement-order.md` | `flows/settlement-order-create.md`、`flow/settlement.md`（无前缀）、`bill/flow.md` |
| `runbook/runbook-troubleshooting.md` | `runbooks/troubleshooting.md`、`runbook/error-triage.md`（无前缀） |
| `overview.md`（根目录唯一文件） | `overview/system-overview.md`、`overview/overview-system.md` |
| `module/module-handler-chain.md` | `channel/common-module.md`、`modules/service-layer.md` |
| `ddl/data-ddl-app_db.md` | `data/data-ddl-app_db.md`、`database-schema.md`、`tables.md`、`data-prod-ddl.md`、`custom-ddl.md`、`data-db-ddl-app_db.md` |

## DDL 与多生产库

DDL 材料统一集中在系统层知识库，仓库层只引用、不持有。每个库必有业务领域归属，直接路由到对应领域目录。

系统层根目录固定登记文件 `db-map.md`（与 index.md 并列，不套用 `{kind}-{topic}.md` 公式）：**单张映射表**——业务领域、生产库名、测试库名、域名、DDL 快照、环境差异，每库一行；同名库在生产与测试一致时两列同写库名，不一致时如实分列并把差异写进「环境差异」列。业务领域列链接领域 `index.md`，DDL 列链接 `ddl/data-ddl-{schema}.md`（无快照记 `—`）。工具调用与操作规程写在 `skills/` 下的配套技能，证据与知识细节写在领域文档；无 DDL 快照的库同样登记（下游库归属见各领域 data 文档）。脚本导出直接写 `ddl/`，不经本表路由；本表供排障反查（库名或域名 → 领域）与日志 domain 取值。

每个库一个快照文件，固定放系统层根目录 `ddl/` 下——库可跨业务线（如 member_account_shard 会员/商户共用），不按领域分目录，领域归属由 db-map 反查：

- 快照文件：`ddl/data-ddl-{schema}.md`（`{schema}` 真实库名小写、保留下划线），**脚本导出原样入库**：机器生成、整份替换、无 frontmatter。除下条「字段语义补丁」节外**禁止手工编辑**——其余任何批注下次导出必被冲掉。双库合导的导出文件先按库拆分再入库，一库一文件。文件只含结构定义（表、列、索引、注释）与数据库信息表（库名/idTree/dbType），不含真实数据、口令与凭据。
- 字段语义补丁节：表 COMMENT 常过时（枚举字段尤其严重，新值上线后注释不回写）。快照内固定一节 `## 字段语义补丁`（位于表索引与表DDL详情之间），是快照中**唯一可编辑区域**，由维护 Agent 在确认注释过时后写入，不靠人工维护。行格式 `|表|字段|正确语义|依据|`：字段留空表示修正表注释本身；正确语义写当前完整含义，枚举必须列全量「值=含义」，禁写「同上」「见xx」；依据优先指向代码枚举类（仓+类名），代码中找不到、与用户口头确认的写「日期+确认方式」。**不得凭推测写补丁**——先搜代码枚举核实，拿不准问用户。节内禁用二级标题（`## ` 是导出工具识别的节边界）。重新导出时该节逐字回灌，其余内容整体再生。
- 提炼知识（表归属与读写方、状态字段值域、唯一键取证）一律写在领域 `data/data-state-ownership.md` 等知识文档中，引用快照文件取证；字段/表注释的语义勘误是唯一例外，写快照补丁节（见上条）。
- 按表反查：快照文件名即库名，用表名搜索系统层即可定位库与文档；索引的"按技术线索查找"须覆盖核心表名与状态字段。
- 仓库层引用：每个使用库的仓库建一份薄文件 `data/data-databases.md`，列出本仓读写的库（库名、用途、大致涉及的表域）与数据源标识，链接系统层 `db-map.md` 和对应 `ddl/data-ddl-{schema}.md`；不复制结构内容，仓库其余文档谈表结构时同样链接系统层。
- 更新机制：表结构变更、新增表或新库接入时用整库导出动作重导快照。导出后核对返回的 `tableCount` 与 `skipped`；补丁节自动回灌，无需人工迁移。用 `git diff` 对比新旧表清单与列变化，把实际变化同步进领域 data 文档、引用它的流程文档与 `data-databases.md`，结构没变就不动文档。新库在 `db-map.md` 补登记一行。

## 系统层布局

跨项目知识库（如 system-knowledge）：根目录一个系统 `index.md`（领域清单 + 仓库映射），其下每个业务领域一个目录，领域内部与仓库层同构：

```
system-knowledge/
├── index.md                   # 系统总索引：领域清单 + 仓库映射
├── db-map.md                  # 生产/测试库名 ↔ 领域 ↔ 域名映射表（反查用）
├── ddl/                       # 全部 DDL 快照（脚本导出机器层，跨业务线库中立位置）
│   └── data-ddl-{schema}.md
├── skills/                    # 配套技能：工具调用与操作规程（非知识文档，不套用本规范命名）
└── {业务领域}/                 # 如 实名认证、跨境结算，沿用业务领域中文名
    ├── index.md               # 领域导航
    ├── overview.md
    ├── flow/flow-{topic}.md
    ├── module/module-{topic}.md
    ├── rule/rule-{topic}.md
    ├── interface/interface-{topic}.md
    ├── data/data-{topic}.md   # 状态归属等知识文档（引用 ddl/ 快照取证）
    └── runbook/runbook-{topic}.md
```

- 系统层根目录固定 `index.md`、`db-map.md` 两个文件加 `ddl/` 一个目录；`ddl/` 是系统层唯一存放机器生成文档的目录，文件按库名命名，不套用 `{kind}-{topic}.md` 公式，不含 frontmatter。可另有 `skills/` 存放配套技能（工具调用与操作规程），按技能自身的命名与组织约定维护。

- 领域目录名用稳定的业务领域中文名，与系统索引中的领域名一致；领域内部的类别、目录名、命名公式与仓库层完全一致，不再按领域发明另一套。
- 新建领域目录必须一次建齐全部类别目录，完成标准与仓库层相同。

## 类别完整性

初始化或重建的完成标准：

- `index.md`、`overview.md` 与六个类别目录全部存在。
- 每个类别目录至少一篇实质文档（frontmatter 完整、正文有真实调查内容，不是占位骨架）。
- 确无对象的类别（如纯工具库无持久化数据时省略 `data/`）必须同时满足两个条件：在 `index.md` 已知缺口处写明省略与依据；在完成报告类别清单中列出。以"内容少、不重要、时间不够"为由省略一律不允许——内容少就写一篇小的实质文档。
- 完成报告附类别清单：类别 × 文档数 × 状态（完成 / 显式省略及依据）。

## 存量库迁移

- 新建知识库：直接按本规范产出。
- 已符合规范的库：维持，不重排。
- 不符合规范的存量库：日常维护中新增文件一律按本规范命名落位，不顺手大规模重排；当用户要求归一、规范化或执行重建时，用 `git mv` 批量迁移到本规范布局，同步更新全部链接与元数据 id 引用，并在完成报告中给出迁移前后对照清单。
