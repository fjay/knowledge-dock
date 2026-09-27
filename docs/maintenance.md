# 知识中枢维护规程与动作参考手册

---

## 维护平面定位与权限

知识中枢统一在 443 端口运行。通过维护专属特权令牌（`ACTIONDOCK_AGENT_TOKEN`）访问受控维护视图（`skm`），具备工作区读写、编辑、断链核验、状态审查、分支同步与检查点推进权限。

```bash
ad profile add skm -s https://<cloud-host-ip>:443 -t <ACTIONDOCK_AGENT_TOKEN> -k -d "知识中枢维护服务"
```

---

## 维护智能体五步作业法

维护智能体唤醒后，遵循以下五步执行单仓维护：

```mermaid
flowchart LR
    S1["分支同步 (maintenance.sync)"] --> S2["变更扫描 (maintenance.list)"]
    S2 --> S3["受控编辑 (files.read / files.edit)"]
    S3 --> S4["断链校验 (links.verify)"]
    S4 --> S5["发布与推进 (publish / complete)"]
```

- **分支同步**：拉取主干生产分支合并至文档分支。检测到合并冲突即安全中止合并并返回冲突清单，由智能体介入消解后重新同步。
- **变更扫描**：比对上一次检查点水位与当前最新提交。若无新增提交则直接结束，避免无效消耗。
- **受控编辑**：审查代码差异是否影响架构契约或核心规则。需修改时，优先使用局部编辑打补丁，杜绝大文本重写导致的上下文截断。
- **断链校验**：文档修改后，扫描 Markdown 相对链接与标题锚点，就地修复失效链接。
- **发布与推进**：提交并推送到远端知识分支；调用完成动作将检查点推进至最新提交，记录已核验水位。

---

## 动作自省与发现

维护智能体可通过 ActionDock 自省命令动态查询可用动作与参数定义：

```bash
# 查看挂载的工具包与可用动作
ad info --profile skm

# 列出所有可用动作
ad list --profile skm

# 查看动作详细描述与传参示例
ad describe workspace/files.edit --profile skm
ad describe maintenance/maintenance.sync --profile skm
```

---

## 扁平参数调用规范与传参语法

在终端执行 `ad run` 时，推荐采用扁平参数赋值（`ad run <action> [control-options] [-- <assignments...>]`），杜绝 JSON 嵌套引号转义陷阱：

- **控制选项与数据参数隔离**：`--` 分隔符之前为控制选项（如 `--profile skm`、`--json`），`--` 分隔符之后为业务入参。
- **字符串赋值操作符**（`=`）：`key=value` 严格保留为纯字符串，不进行隐式类型转换（示例：`path="/srv/workspace/order-service"`、`command="git status"`）。
- **非字符串赋值操作符**（`:=`）：`key:=json` 用于传递数值、布尔值或复杂 JSON 结构（数值示例：`depth:=1`、`startLine:=1`、`maxLines:=100`；布尔值示例：`checkAnchors:=true`、`fixedStrings:=true`）。
- **数组参数传递规则（特别注意）**：
  - **连续点号索引语法（首选推荐）**：使用纯数字从 `0` 开始连续递增。例如 `paths` 为数组时，必须写作 `paths.0="src" paths.1="docs"`。数组索引必须从 0 开始连续编号，严禁跳号或稀疏数组。
  - **JSON 数组直接赋值语法**：使用 `:=` 赋值操作符直接传入 JSON 数组字符串，例如 `paths:='["src", "docs"]'`。
- **模式互斥红线**：扁平参数、`--input <json>` 与 `--input-file <path>` 严格互斥，严禁混用。

---

## 核心维护动作速查

### 代码分支同步：`maintenance/maintenance.sync`

- **用途**：同步最新主干代码至知识分支（若本地工作区不存在该目录且提供了 `url`，将自动从远端克隆）。
- **参数**：`path`（可选，单仓路径；省略时同步所有仓库）、`url`（可选，远端 Git 克隆地址）。
- **范例**：
  ```bash
  # 同步指定仓库
  ad run maintenance/maintenance.sync --profile skm -- path=/srv/workspace/order-service

  # 全量同步所有配置仓库
  ad run maintenance/maintenance.sync --profile skm
  ```

### 代码变更扫描：`maintenance/maintenance.list`

- **用途**：计算检查点水位与最新 HEAD 之间的提交增量与变动文件。
- **参数**：`path`（可选，指定单仓路径）。
- **范例**：
  ```bash
  # 扫描指定仓库变更
  ad run maintenance/maintenance.list --profile skm -- path=/srv/workspace/order-service

  # 批量扫描所有仓库
  ad run maintenance/maintenance.list --profile skm
  ```

### 工作区读写与受控编辑

维护智能体应优先使用局部编辑（`files.edit`）进行精准替换，避免全量写入（`files.write`）丢失大段上下文。

- **跨目录关键字检索**：`workspace/search.rg`（多路径数组连续索引示例）
  ```bash
  ad run workspace/search.rg --profile skm -- pattern="payment" paths.0="order-service/src" paths.1="order-service/docs"
  ```
- **分段读取文档**：`workspace/files.read`
  ```bash
  ad run workspace/files.read --profile skm -- path=order-service/docs/api.md startLine:=1 maxLines:=100
  ```
- **局部精准编辑**：`workspace/files.edit`
  ```bash
  ad run workspace/files.edit --profile skm -- path=order-service/docs/api.md targetContent="timeout: 3000" replacementContent="timeout: 5000"
  ```
- **安全全量写入**：`workspace/files.write`（通常仅用于新建文档）
  ```bash
  ad run workspace/files.write --profile skm -- path=order-service/docs/new.md content="# 架构说明\n..."
  ```

### 文档断链校验：`workspace/links.verify`

- **用途**：扫描文档内的相对链接与标题锚点，排查死链。
- **调用时机**：文档修改完成、提交发布前。
- **范例**：
  ```bash
  ad run workspace/links.verify --profile skm -- path=/srv/workspace/order-service
  ```

### 变更审查与回滚：`workspace/bash.exec`

- **用途**：执行版本状态查看、差异核验与改动回滚，确保只改动文档目录，未误动业务代码。执行输出直接映射为 `content` 原生终端输出流，退出码独立输出至 stderr。
- **范例**：
  ```bash
  # 查看当前工作区变更状态
  ad run workspace/bash.exec --profile skm -- command="git status" cwd=/srv/workspace/order-service

  # 查看具体修改差异
  ad run workspace/bash.exec --profile skm -- command="git diff" cwd=/srv/workspace/order-service

  # 发现误改时执行回滚丢弃修改
  ad run workspace/bash.exec --profile skm -- command="git restore ." cwd=/srv/workspace/order-service
  ```

### 文档发布与推进检查点

- **发布更新**：`maintenance/maintenance.publish`
  ```bash
  ad run maintenance/maintenance.publish --profile skm -- path=/srv/workspace/order-service message="docs: update payment timeout"
  ```
- **推进检查点**：`maintenance/maintenance.complete`（无论文档是否修改均须执行）
  ```bash
  ad run maintenance/maintenance.complete --profile skm -- path=/srv/workspace/order-service commit="<TO_COMMIT>" actionTaken="docs_updated" summary="更新超时说明"
  ```

---

## 候选经验管理与归档

```bash
# 查看待审经验清单
ad run knowledge/knowledge.list --profile skm

# 提炼后将经验文件归档
ad run knowledge/knowledge.archive --profile skm -- id="20260926-a1b2c3" resolution="accepted" note="已归入 payment 手册"
```

---

## 编排技能对接

在自动化工作流中，挂载配套技能 [skills/knowledge-maintenance-orchestrator/SKILL.md](../skills/knowledge-maintenance-orchestrator/SKILL.md) 唤醒智能体：

```text
请激活 【knowledge-maintenance-orchestrator】 技能，针对指定的单一仓库执行一轮知识维护闭环。
```
