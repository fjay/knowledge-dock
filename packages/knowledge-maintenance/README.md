# actiondock-knowledge-maintenance

[ActionDock](https://github.com/team4u/actiondock) 高权限维护平面，专用于知识库自动维护与反馈闭环架构。

本包运行在云主机后台，负责代码仓与系统知识仓的 Git 同步、变更扫描及审查检查点推进。

---

## 核心定位与架构分工

| 组件 / 包 | 定位 | 权限模式 | 职责 |
|---|---|---|---|
| `knowledge-workspace` | 工作区能力平面 | 读写受控 | 为 Agent 提供工程检索、受控读写与工作区内终端执行 (`search.rg`, `files.read`, `files.list`, `files.write`, `files.edit`, `bash.exec`)，对外只读由查询视图动作白名单实现 |
| `knowledge-inbox` | 反馈追加平面 | 追加写入 | 收集人工排障与补充候选文档 (`knowledge.collect`) |
| `knowledge-maintenance` | 特权维护平面 | 受控写入 | 双分支代码仓与单分支系统知识仓的同步、待维护扫描与检查点推进 |

### 仓库分支模型

- **业务代码仓**：双分支模式。代码在 `release` 分支迭代，知识在 `docs` 分支维护。同步时将 `origin/release` 合入 `docs` 并推送到远端。
- **系统知识库仓**：单分支模式 (`master`)。存放跨仓系统级知识，纯文档仓，直接 fast-forward 同步 `origin/master`。

---

## 核心 Action 列表

### `maintenance.sync`

- **入口**：`actions/maintenance-sync.ts`
- **功能**：
  - 校验目标路径为有效 Git 仓库 (`git rev-parse --is-inside-work-tree`)。
  - 检查工作区干净程度 (`git status --porcelain`)，若存在未提交修改则安全退出并返回 `status: "dirty_worktree"`。
  - 执行 `git fetch origin` 获取最新远端引用。
  - **单分支/系统知识仓** (`system_knowledge`)：切换至 `sourceBranch` (默认 `master`)，执行 `git merge --ff-only origin/<sourceBranch>`。
  - **双分支代码仓** (`code`)：
    - 检查远端是否存在 `knowledgeBranch` (默认 `docs`)。若远端不存在，则以 `origin/<sourceBranch>` 初始化并 `git push origin docs`。
    - 切换至 `knowledgeBranch`，执行合并 `git merge --no-edit origin/<sourceBranch>`。
    - 合并成功后自动执行 `git push origin <knowledgeBranch>`。
    - **安全回滚**：若产生冲突，**绝不 force push 或 hard reset**，立即执行 `git merge --abort` 退出，并返回 `status: "conflict"` 及冲突文件列表。

### `maintenance.list`

- **入口**：`actions/maintenance-list.ts`
- **功能**：
  - 获取目标分支的当前 HEAD commit。
  - 从 `ctx.state` 读取该仓库持久化的检查点记录（命名空间 `checkpoints/<repo>`，内容为含 `commit`、`actionTaken`、`summary`、`updatedAt` 的对象）。
  - **首次无检查点**：返回 `hasChanges: true`, `from: null`, `to: <HEAD>`, `commitCount`, `initialInventoryRequired: true`，提示需要首次全盘盘点。
  - **Checkpoint 与 HEAD 一致**：返回 `hasChanges: false`，无需再次检查。
  - **存在新变更**：通过 `git log` 和 `git diff --stat` 提取提交明细与变更统计，返回结构化提交列表与文件变更摘要。

### `maintenance.complete`

- **入口**：`actions/maintenance-complete.ts`
- **功能**：
  - 校验 commit 格式（7~40 位 16 进制字符）。
  - 验证 commit 在仓库中真实有效 (`git cat-file -e <commit>^{commit}`)。
  - 解析完整 40 位哈希并更新持久化存储 `ctx.state`。
  - 返回 `{ repo, path, previousCommit, currentCommit, actionTaken, summary, updatedAt }`。

### `maintenance.publish`

- **入口**：`actions/maintenance-publish.ts`
- **功能**：
  - 校验目标路径为有效 Git 仓库并检查工作区状态，若工作区干净直接返回 `status: "no_changes"`。
  - **参数**：`path`（仓库路径）、`files`（可选，仅提交指定文件清单，缺省提交全部变更）、`message`（提交信息，缺省 `docs: update knowledge documentation`）、`branch`（可选，目标分支）、`push`（可选，是否推送远端，默认 true）。
  - 确保位于目标分支后执行 `git add` 与 `git commit`，并按需推送至远端。
  - 返回 `{ status, path, repo, branch, committed, pushed, commit, files, message }`。
---

## 编排执行与定时调度

支持通过 ActionDock 原生动作执行维护任务：

- 单仓同步：
  ```bash
  ad run maintenance.sync --profile skm -- path=/srv/workspace/order-service
  ```
- 批量同步：
  ```bash
  ad run maintenance.sync --profile skm
  ```

### JSON 配置文件示例

```json
[
  {
    "path": "/srv/workspace/order-service",
    "repoType": "code",
    "sourceBranch": "release",
    "knowledgeBranch": "docs"
  },
  {
    "path": "/srv/workspace/system-knowledge",
    "repoType": "system_knowledge",
    "sourceBranch": "master"
  }
]
```

### Cron 定时调度示例

使用 ActionDock 原生动作命令执行定时调度：

```crontab
# 每天凌晨 2 点通过 ActionDock 执行知识库批量同步维护
0 2 * * * ad run maintenance.sync --profile skm >> /var/log/actiondock-maintenance.log 2>&1
```

---

## 大仓性能优化：Blobless Clone（部分克隆）最佳实践

针对拥有海量历史与大文件的仓库群，本包默认启用 Blobless 模式（`--filter=blob:none`）：

- **为什么不使用浅克隆**（`--depth`）？
  - 浅克隆会切断提交历史，导致 `release -> docs` 跨分支合并时找不到共同祖先（`merge-base` 缺失报错：`fatal: refusing to merge unrelated histories`）；
  - 也会导致 `maintenance.list` 在比对旧 Checkpoint 时因缺少历史对象而无法生成差异。
- **Blobless 模式优势**：
  - **仅下载提交图谱（Commit/Tree）**，完整保留分支图与历史演进，合并与水位追溯 100% 安全；
  - **不下载历史大文件（Blob）**，节省 80%~95% 磁盘空间与拉取时间，和浅克隆一样快；
  - 支持向远端正常执行 `git push origin docs`。
- **首次检出建议**：
  ```bash
  # 云主机首次拉取大仓时推荐使用：
  git clone --filter=blob:none <repo-url> /srv/workspace/<repo-name>
  ```
- **自动降级支持**：
  - `maintenance.sync` 在执行 `fetch` 时默认携带 `--filter=blob:none`；
  - 若自建远端 Git 服务端未开启 Partial Clone 支持，自动无缝降级为标准 fetch，稳定可靠。

---

## 开发与质量规范

本包严格遵循 ActionDock 规范红线：
- **进程隔离**：严禁使用 Node 原生 `child_process`，所有 Git 交互均通过 `ctx.process.run` 驱动，并绑定超时时限、缓冲区大小及 `ctx.signal`。
- **结构化日志**：严禁使用 `console.log`，全量调用 `ctx.log.info / warn / error / debug`。
- **强类型与契约**：基于 Schema v2 规范编写 `actiondock.json`，通过 `ad generate types` 导出类型。
- **确定性测试**：利用 `@actiondock/testing` 的 `FakeProcessDriver` 进行纯内存确定性测试。

### 运行测试与验证

```bash
# 校验 ActionDock Action 规范与模式契约
ad validate

# 运行 TypeScript 类型检查
npm run typecheck

# 执行全量单元测试
npm test
```
