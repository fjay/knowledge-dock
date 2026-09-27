---
name: knowledge-maintenance-orchestrator
description: 知识维护单仓编排技能，通过 ActionDock 特权维护服务驱动单仓全生命周期的代码同步、变更核验、知识编写、断链自检自愈、发布推送及检查点推进自闭环。
metadata:
  version: 2.0.0
---

# 知识维护单仓自闭环编排

作为知识维护单仓自闭环专家智能体，通过 ActionDock 纯动作规范依托特权维护服务驱动单一代码仓的端到端自动化维护闭环。在大规模多仓流水线中，宏观批量巡检与调度由本地驱动器承担，本智能体每次唤醒严格聚焦于指定的单个目标仓库，负责分支同步、变更核验、文档编写、断链自愈、统一发布与检查点推进，实现确定性交付。

---

## 核心定位与协作分工

- **核心定位**：本技能是知识中枢单仓全生命周期的自闭环编排规范，面向云端维护智能体。智能体依托特权维护服务统一完成单仓端到端闭环，杜绝跨仓批量长链路会话膨胀与无状态脚本拼接。
- **调度分工**：在大规模多仓场景下，多仓批量循环、断点续传与观测看板由本地流水线调度器（Pipeline Runner）承担。智能体每次被唤醒仅承接单个仓库的维护任务，保持上下文极致轻量。
- **环境依赖**：执行过程依赖 ActionDock 特权维护服务（服务端口 443，配置标识 `--profile skm`）。所有维护动作（`maintenance/*`）与工作区读写动作（`workspace/*`）统一在此受控环境中执行。
- **远端工具探索与模式自省**：所有工具调用统一基于 ActionDock 纯动作协议：
  - 通过 `ad info --profile skm` 查看远端所有挂载的工具包、动作与规程概览。
  - 通过 `ad list --profile skm` 列出远端所有可用动作清单及其功能描述。
  - 通过 `ad describe <action> --profile skm` 查询具体动作的完整描述、模式定义以及推荐的传参示例。
  - 通过 `ad info <package> --profile skm` 查看具体工具包内的所有动作与规程。
- **扁平参数调用规范与传参语法**：在终端执行 `ad run` 时，推荐采用扁平参数赋值（`ad run <action> [control-options] [-- <assignments...>]`），杜绝 JSON 嵌套引号转义陷阱：
  - 控制选项与数据参数隔离：`--` 分隔符之前为控制选项（如 `--profile skm`、`--json`），`--` 分隔符之后为业务入参。
  - **字符串赋值操作符**（`=`）：`key=value` 严格保留为纯字符串，不进行隐式类型转换（示例：`path="/srv/workspace/order-service"`、`command="git status"`）。
  - **非字符串赋值操作符**（`:=`）：`key:=json` 用于传递数值、布尔值或复杂 JSON 结构（数值示例：`depth:=1`、`startLine:=1`、`maxLines:=100`；布尔值示例：`checkAnchors:=true`、`fixedStrings:=true`）。
  - **数组参数传递规则（特别注意）**：
    - 连续点号索引语法（首选推荐）：使用纯数字从 `0` 开始连续递增。例如 `paths` 为数组时，必须写作 `paths.0="/srv/workspace/order/src" paths.1="/srv/workspace/order/docs"`。数组索引必须从 0 开始连续编号，严禁跳号或稀疏数组。
    - JSON 数组直接赋值语法：使用 `:=` 赋值操作符直接传入 JSON 数组字符串，例如 `paths:='["src", "docs"]'`。
  - **嵌套对象传参规则**：通过点号连接各层级属性名，例如 `metadata.author="agent" metadata.version:=2`。
  - **模式互斥红线**：扁平参数、`--input <json>` 与 `--input-file <path>` 严格互斥，严禁混用。
- **绝对交付标志**：`maintenance.complete` 动作是本仓维护任务圆满完成与最终交付的唯一绝对事实源。执行成功后，外部调度驱动器立即感知检查点推进并闭环本仓。

---

## 单仓闭环核心铁律

维护智能体对指定目标仓库执行维护时，必须恪守以下闭环五步铁律：

- **核验**：执行代码分支同步与变更扫描，精确定位前置检查点与目标提交之间的差异范围，判定维护场景（冷启动建库、增量核验或无变更）。
- **编辑与新增**：深入业务源码与配置事实，遵循统一目录布局，按需编写或编辑知识文档，严禁误触业务代码。
- **断链自检自愈**：文档编写完成后，必须主动运行 `workspace/links.verify` 进行死链审查；若存在断链，就地修复至零断链，严禁遗留断链。
- **统一发布**：确认门禁通过且存在实质文档变动时，调用 `maintenance.publish` 统一提交并推送到远端知识分支。
- **推进检查点水位**：无论文档是否需要变动，流程结束前必须调用 `maintenance.complete` 将检查点推进至目标提交，完成闭环交付。

---

## 标准化执行流程

### 分支同步与冲突消解

调用维护同步动作拉取代码仓更新并合入知识分支：

- **单仓定向同步调用**：
  ```bash
  ad run maintenance/maintenance.sync --profile skm -- path="<repoPath>"
  ```
- **同步返回决议判定**：
  - **执行成功**（`status == "success"`）：代码分支同步成功完成，直接进入变更扫描环节。
  - **存在冲突**（`status == "conflict"`）：同步动作已安全中止合并（`git merge --abort`），工作区恢复干净，返回结果中的 `conflictFiles` 仅是冲突文件清单，文件中已无冲突标记。消解规程：
    - 调用 `workspace/bash.exec`（`--profile skm -- command="git merge origin/<sourceBranch>" cwd="<repoPath>"`）在工作区内重新发起合并，使冲突真实落盘。
    - 调用 `workspace/files.read`（`--profile skm -- path="<repoPath>/<conflictFile>"`）逐个读取带冲突标记的文档内容。
    - 理解本地知识分支与远端变更两端事实，消除冲突标记，合成为最准确完备的知识文档。
    - 调用 `workspace/files.write`（`--profile skm -- path="<repoPath>/<conflictFile>" content="<消解后的文档内容>"`）安全写回，再调用 `workspace/bash.exec` 执行 `git add <conflictFile> && git commit` 完成合并提交。
    - 调用 `maintenance/maintenance.publish`（`--profile skm -- path="<repoPath>" message="docs(merge): resolve knowledge conflict"`）推送消解成果。
    - 冲突消解完成后，继续进入变更扫描环节。
  - **执行异常**（`status == "error"`）：记录错误详情并终止后续流程。

### 变更扫描与场景判定

调用维护变更扫描动作比对代码提交差异：

- **单仓扫描调用**：
  ```bash
  ad run maintenance/maintenance.list --profile skm -- path="<repoPath>"
  ```
- **场景判定与处理分流**：
  - **无代码变更场景**（`hasChanges == false` 且无需冷启动建库）：
    - 判定说明：文档已与最新代码基线完全对齐，无需更新知识文档。
    - 后续动作：跳过文档核验与编辑，直接调用 `maintenance.complete` 推进检查点水位至最新提交。
  - **冷启动建库场景**（`initialInventoryRequired == true` 或仓库缺少知识文档骨架）：
    - 判定说明：仓库首次接入知识中枢，或需全面补齐六大类知识资产。
    - 处理动作：按六大类别（`flow`、`module`、`rule`、`interface`、`data`、`runbook`）深入源码产出实质文档并生成根目录 `index.md` 与 `overview.md`。
  - **增量核验场景**（`initialInventoryRequired == false` 且 `hasChanges == true`）：
    - 判定说明：代码存在提交增量，需验证既有文档有效性。
    - 处理动作：根据变更提交与差异文件切片，针对受影响的功能模块与对外契约进行核验与文档更新。

### 源码核验与文档编写

针对目标仓库进行深入核验与规范编写：

- **知识分类与落盘规范**：
  - 目录路径：`/srv/workspace/<target-repo>/docs/knowledge/<category>/`
  - 文件命名：`<category>-<topic>.md`
  - 六大知识分类：
    - flow 类别：业务端到端主流程、关键分支、关联键流转与失败传播。
    - interface 类别：对外 HTTP 与 RPC 接口、消息队列事件与调度任务的契约定义及入出参。
    - rule 类别：跨流程公共规则、校验约束、多商户隔离策略与计算公式。
    - module 类别：核心模块划分、分层职责与内部调用拓扑。
    - data 类别（红线约束）：本仓仅建 `data/data-databases.md` 轻量引用索引，注明所涉表域与数据源。严禁在代码仓自身文档中复制粘贴全量表结构或建表脚本。
    - runbook 类别：排障手册、高频错误码、运维配置与故障自愈流程。
- **常用受控维护工具动作**：
  - 全文检索：`ad run workspace/search.rg --profile skm -- pattern="<keyword>" paths.0="/srv/workspace/<path>/src" paths.1="/srv/workspace/<path>/docs"`
  - 分段直读：`ad run workspace/files.read --profile skm -- path="/srv/workspace/<path>" startLine:=1 maxLines:=2000`
  - 局部编辑：`ad run workspace/files.edit --profile skm -- path="/srv/workspace/<path>" targetContent="<old>" replacementContent="<new>"`
  - 安全写入：`ad run workspace/files.write --profile skm -- path="/srv/workspace/<path>" content="<content>"`
  - 目录浏览：`ad run workspace/files.list --profile skm -- path="/srv/workspace/<dir>" depth:=1`
  - 终端命令与改动回滚：`ad run workspace/bash.exec --profile skm -- command="git restore ." cwd="/srv/workspace/<path>"`（执行输出直接映射为 `content` 原生终端流）

### 断链自检自愈门禁

在完成任何文档的新建或编辑后，智能体必须严格执行断链审查与自愈：

- **断链审查调用**：
  ```bash
  ad run workspace/links.verify --profile skm -- path="<repoPath>"
  ```
- **门禁放行条件**：全面核验相对路径死链、图片资产缺失与失效标题锚点。若存在断链（`brokenCount > 0`），结合 `brokenLinks` 清单使用 `workspace/files.edit` 立即就地修复，直至断链数为零（`brokenCount === 0`）方可放行。
- **工作区状态与差异审查**：
  ```bash
  ad run workspace/bash.exec --profile skm -- command="git status" cwd="<repoPath>"
  ad run workspace/bash.exec --profile skm -- command="git diff" cwd="<repoPath>"
  ```
  确认所有修改完全收敛于文档目录下，严禁误触或修改任何业务源码与构建配置。若发生误改，可执行 `command="git restore ."` 立即回滚。

### 统一发布推送

确认门禁全部合规且存在实质文档变动时，执行统一提交与推送：

- **单仓知识文档发布调用**：
  ```bash
  ad run maintenance/maintenance.publish --profile skm -- path="<repoPath>" message="docs: update knowledge documentation"
  ```
- **发布状态决议**：确认推送成功并获取发布 commit。若仅核验而无需修改文档，则跳过发布步骤，直接推进检查点。

### 推进检查点水位（绝对交付标志）

无论本次维护是否产生文档变动，流程最后必须将水位推进至变更扫描返回的 `to` 提交，这是单仓任务圆满结束的法定标志：

- **更新知识文档场景**：
  ```bash
  ad run maintenance/maintenance.complete --profile skm -- path="<repoPath>" commit="<TO_COMMIT>" actionTaken="docs_updated" summary="<更新说明>"
  ```
- **核验确认无需修改文档场景**：
  ```bash
  ad run maintenance/maintenance.complete --profile skm -- path="<repoPath>" commit="<TO_COMMIT>" actionTaken="no_change_needed" summary="<代码重构或优化，业务逻辑与知识未失效>"
  ```
- **交付响应**：检查点更新后，外部调度器（Pipeline Runner）将通过轮询感知检查点推进，判定本仓成功闭环。

---

## 交付报告规范

单仓维护流程执行完毕后，智能体输出结构化交付结算摘要：

```markdown
# 单仓知识维护交付报告

- 目标仓库：<仓库名称>
- 远端工作区路径：<repoPath>
- 维护场景：<冷启动建库 / 增量核验 / 无代码变更>
- 前置检查点：<FROM_COMMIT>
- 目标检查点：<TO_COMMIT>
- 分支同步状态：<成功 / 冲突已自愈消解>
- 文档变更清单：
  - <新建或编辑的文档相对路径及概要说明>
- 断链自检门禁：
  - 扫描文件数：<数字>
  - 校验链接数：<数字>
  - 断链数：0（已达标）
- 检查点推进决议：
  - 提交水位：<TO_COMMIT>
  - 处置决议：<docs_updated / no_change_needed>
  - 推进状态：成功
```
