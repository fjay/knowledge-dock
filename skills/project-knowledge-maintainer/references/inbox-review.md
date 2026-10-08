# Knowledge Inbox 消费与审核规程

Knowledge Inbox 是所有排障经验、人工补充与修正建议进入正式知识库前的缓冲池。本规程指导维护智能体运行在云主机或高权限会话中，对待审候选文档进行审核、消歧、去重、合入正式知识库并推进归档。

---

## 核心设计与合并铁律

- **候选文档是贡献单元，不是知识存储单元**：
  - 严禁机械地“一条候选文档新建一个知识文件”。
  - 候选文档必须被消化并合入到现有规范文档（`flow/`、`rule/`、`runbook/`、`data/`、系统层业务域、或 `ddl/` 语义补丁）中。
- **严守布局与命名规范**：
  - 所有合入动作严格遵守 [layout.md](layout.md)（六大单数类别目录：`flow`、`module`、`rule`、`interface`、`data`、`runbook`，统一 `{kind}-{topic}.md` 命名）。
- **以最新代码与现有文档为准**：
  - 候选文档中记录的结论必须回查代码（利用 `search.rg` 或本地源码）核验，防止引入过时、错误或仅限特定测试环境的偏颇结论。
- **必须完成归档闭环**：
  - 每篇候选文档处理完成后，必须调用 `knowledge.archive` 给出明确决议（`accepted`、`duplicate`、`insufficient_evidence`、`rejected`），确保 `pending/` 待办池不积压。

---

## 双子代理协同初筛与消费架构

待审池消费由主智能体统筹调度两个专业子代理分工闭环：

- **版本初筛与消歧子代理**：
  - 核心职责：全量扫描待审池候选列表（`knowledge.list status="pending"`），基于作者、业务领域与主题词聚类分析版本演进关系（例如 v1/v2/v3 修订链）；
  - 快速初筛与版本收敛：调阅候选文档，识别废弃声明与版本更替说明。对已被后续版本吸收或证伪的历史版本（如 v1、v2），直接调用 `knowledge.archive` 动作快速归档（决议设为 `duplicate` 或 `rejected`，说明注明“非终版，已被终版候选 <id> 吸收替代”）；
  - 产出有效终版清单：将收敛后的有效终版候选交接给合入子代理，避免对过时版本进行重复无效的代码核验。
- **核心经验核验与合入子代理**：
  - 核心职责：仅聚焦初筛子代理输出的有效终版候选，深入对应代码仓检索源码核实事实；
  - 提炼合入规范目录（`flow/`、`rule/`、`runbook/` 或 `ddl/` 语义补丁），执行 `links.verify` 零断链自愈，统一提交发布，并调用 `knowledge.archive` 将终版候选归档为 `accepted`。

---

## 审核消费标准流程

```mermaid
flowchart TD
    A["拉取待审候选<br>(knowledge.list status=pending)"] --> B["版本演进初筛与聚类<br>(梳理作者、仓库与修订链)"]
    B -->|"历史版本已被终版吸收"| C["快速归档收敛<br>(knowledge.archive duplicate/rejected)"]
    B -->|"有效终版候选"| D["阅读候选正文<br>(knowledge.get / id)"]
    D --> E["回查源码与现有知识<br>(search.rg / files.read)"]
    E --> F{"事实核验与决议"}
    F -->|"事实确凿且知识缺失"| G["合入正式知识库<br>(flow / rule / runbook / ddl)"]
    G --> H["knowledge.archive<br>resolution=accepted"]
    F -->|"已有相同记载"| I["knowledge.archive<br>resolution=duplicate"]
    F -->|"关键证据不足/缺少对端代码"| J["knowledge.archive<br>resolution=insufficient_evidence"]
    F -->|"结论错误/非知识问题"| K["knowledge.archive<br>resolution=rejected"]
    H --> L["Git commit 提交 docs 分支"]
```

### 扫描待处理候选文档
调用 `actiondock-knowledge-inbox` 的 `knowledge.list`（挂载 `--profile skm`）：
```bash
ad run knowledge.list --profile skm -- status="pending"
```
出参返回 `items` 数组，包含每个待审文档的 `id`、`filename`、`title`、`domain`、`tags`、`createdAt` 等。

### 阅读候选内容并核查代码
- 使用 `ad run knowledge.get --profile skm -- id="<id>"` 查看候选文档完整 Markdown 正文与元数据；
- 提取候选文档中的证据链（类、方法、日志特征、表名、配置项）；
- 使用 `search.rg --profile skm` 在相关工程中核验该逻辑是否真实存在且为当前最新分支逻辑；
- 查阅目标仓或系统域当前的知识文档，评估该知识是否已被覆盖。

### 决议流转与归档

#### 采纳合入（accepted）
- **判定标准**：事实准确、代码已确证、在当前知识库中确实存在缺口。
- **合入目标选择**：
  - **排障手段与错误码**：优先合入对应仓的 `runbook/runbook-{topic}.md`，或在对应 `flow/flow-{topic}.md` 的失败传播链/排查指引中补充。
  - **主干流程与分支**：补充或修正对应仓或系统层业务域的 `flow/flow-{topic}.md` 与 `overview.md`。
  - **公共规则与约束**：合入 `rule/rule-{topic}.md`。
  - **数据库字段语义勘误**：合入系统层 `ddl/data-ddl-{schema}.md` 的 `## 字段语义补丁` 节（格式：`|表|字段|正确语义|依据|`）。
- **执行归档**：
  ```bash
  ad run knowledge.archive --profile skm -- id="<id>" resolution="accepted" note="已合入 <目标文档相对路径>"
  ```

#### 重复候选（duplicate）
- **判定标准**：候选文档记录的事实、错误码或规则，在现有知识库中已有完整且准确的记载；或同源版本演进链中的历史版本，已被终版候选吸收替代。
- **执行归档**：
  ```bash
  ad run knowledge.archive --profile skm -- id="<id>" resolution="duplicate" note="非终版，已被终版候选 <终版id> 吸收替代"
  ```

#### 证据不足（insufficient_evidence）
- **判定标准**：排查结论存在大段未确认事项（unknowns）、缺少对端工程源码无法闭环推断、或属于偶发网络/硬件抖动无法复现。
- **执行归档**：
  ```bash
  ad run knowledge.archive --profile skm -- id="<id>" resolution="insufficient_evidence" note="缺少对端系统源码核实，暂不入库"
  ```

#### 拒绝采纳（rejected）
- **判定标准**：属于个人开发环境特有失误、已废弃过时的历史遗留逻辑、经查证与源码事实相悖；或同主题历史版本被后续终版推翻证伪。
- **执行归档**：
  ```bash
  ad run knowledge.archive --profile skm -- id="<id>" resolution="rejected" note="经核对源码为废弃接口，无需入库（或：已被终版候选 <终版id> 废弃证伪）"
  ```

### 正式知识库提交
完成所有 `accepted` 候选的文档合入后：
- 核对修改的文件均符合 [layout.md](layout.md) 与 [metadata.md](metadata.md)；
- 运行 `git diff` 检查改动精度，杜绝无关格式变化；
- 执行 `git commit`（如 `docs: merge knowledge inbox candidates (KB-xxx)`）并推送到远端知识分支。
