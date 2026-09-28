# 运维手册

运维目标是确认每轮代码提交已被审查，并确保发布只包含预期知识变更。当前版本的链接和改动范围检查需要维护流程显式调用；`maintenance.publish` 不会自动替你完成这些检查。

## 查看待审增量

```bash
ad run maintenance/maintenance.list --profile skm
ad run maintenance/maintenance.list --profile skm -- path="/srv/workspace/order-service"
```

`initial` 表示尚无检查点，需要完成首次知识盘点；`changed` 表示有未审提交；`upToDate` 表示目标分支与检查点一致。使用返回的 `to` 作为本轮审查目标。同步或扫描失败时先处理错误，不能直接调用 `maintenance.complete` 以跳过变更。

检查点基线推进机制记录“这个提交及以前的变更已完成审查”。即使确认文档无需修改，也应写入结论，避免同一批提交在下一轮重复进入审查。

## 发布前检查

知识维护应只修改目标知识目录。当前 `maintenance.publish` 在未指定 `files` 时会执行 `git add -A`，且提交时会包含已有的暂存改动。因此发布前必须分别检查工作区和暂存区，不要在发现越界文件时继续发布。

- 检查目标仓库的改动：

  ```bash
  ad run workspace/bash.exec --profile skm -- \
    cwd="/srv/workspace/order-service" \
    command="git status --short"
  ad run workspace/bash.exec --profile skm -- \
    cwd="/srv/workspace/order-service" \
    command="git diff --cached --name-only"
  ```

- 确认改动只涉及本轮需要更新的 `docs/knowledge/` 文件。发现业务源码、配置或其他无关改动时停止发布，查明来源并分别处理。不要对共享工作区执行 `git restore .` 之类的全量丢弃命令。
- 检查链接。`links.verify` 报告断链，不会自行改写文件；根据 `brokenLinks` 修复后再次检查，直到 `brokenCount` 为零：

  ```bash
  ad run workspace/links.verify --profile skm -- \
    path="/srv/workspace/order-service/docs/knowledge"
  ```

- 再次核对暂存区。可以在发布时传入明确文件列表，减少默认全量暂存的范围；这不能排除调用前已经暂存的其他文件：

  ```bash
  ad run maintenance/maintenance.publish --profile skm -- \
    path="/srv/workspace/order-service" \
    files.0="docs/knowledge/flow/flow-order-create.md" \
    message="docs: update order flow"
  ```

只有发布返回成功且需要推送时 `pushed` 为真，才推进本轮文档更新的检查点。没有文档变更时不调用发布动作。

## 推进检查点

目标提交必须是当前仓库中实际存在的提交哈希，通常取自 `maintenance.list` 的 `to`：

```bash
ad run maintenance/maintenance.complete --profile skm -- \
  path="/srv/workspace/order-service" \
  commit="<本轮扫描返回的 to 提交哈希>" \
  actionTaken="docs_updated" \
  summary="已核对并更新订单流程文档"
```

若审查结论是不需要更改文档，将 `actionTaken` 改为 `no_change_needed`，并在 `summary` 写出判断依据。`maintenance.complete` 会检查提交是否存在，但不会验证文档是否已发布或结论是否正确；它应由维护流程在检查完成后调用。

需要重新审查一段历史时，可以有意识地把检查点设为较早且仍存在的提交。先确认仓库分支关系与目标哈希，再记录原因；随意回退或跳过检查点会改变下一轮扫描范围。

## 处理待审候选

```bash
ad run knowledge/knowledge.list --profile skm -- status="pending"
```

对照候选中的 `repos`、证据和现有知识核查事实。采纳时先更新并发布正式知识，再归档候选：

```bash
ad run knowledge/knowledge.archive --profile skm -- \
  id="<候选标识>" \
  resolution="accepted" \
  note="已合入对应排障手册"
```

`duplicate`、`rejected` 和 `insufficient_evidence` 同样需要在 `note` 写明依据。归档动作只改变待审池状态，不会自动改动 Git 文档。候选中若有无法核实的事实，应保留其不确定性，不能为了清空待审池而采纳。

## 故障定位

| 状态或现象 | 处置 |
|---|---|
| `dirty_worktree` | 核对工作区已有改动的来源，分别处理后重试同步 |
| `conflict` | 阅读返回的 `conflictFiles`，核对两侧代码与文档语义后处理合并 |
| `initial` 长期不收敛 | 确认首次盘点任务是否执行，完成后核对检查点是否推进 |
| 流水线超时 | 查派发任务结果与 `maintenance.list` 的检查点，不要直接提高超时掩盖失败 |
| 候选重复出现 | 检查维护智能体是否调用 `knowledge.archive` 并确认候选已离开 `pending` |
| 服务启动失败 | 使用 `docker compose logs knowledge-server` 查看令牌、证书和挂载错误 |

本地流水线日志由 `logFile` 控制，结算报告由 `reportFile` 控制；服务运行日志通过 `docker compose logs knowledge-server` 查看。当前仓库没有保证生成固定的 `access.log` 或 `audit.log` 文件，不应把这些文件当作唯一审计依据。
