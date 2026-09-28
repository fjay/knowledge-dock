# 仓库维护动作包

`knowledge-maintenance` 管理纳管仓库的 Git 同步、提交差异扫描、文档发布和检查点。它属于维护视图 `skm`。业务仓使用主干分支与知识分支，系统知识仓使用单分支。

| Action | 用途 | 关键入参 |
|---|---|---|
| `maintenance.sync` | 克隆或同步仓库；业务仓合并主干至知识分支 | 可选 `path`、`config`、`url`、`sourceBranch`、`knowledgeBranch` |
| `maintenance.list` | 比较目标提交与检查点，列出待审增量 | 可选 `path`、`config`、`branch` |
| `maintenance.publish` | 暂存、提交并可选推送改动 | `path`；可选 `files`、`branch`、`message`、`push` |
| `maintenance.complete` | 把已审查的提交哈希写入检查点 | `path`、`commit`；可选 `actionTaken`、`summary` |

省略 `path` 时，`sync` 与 `list` 使用仓库清单批量处理；默认清单为 `/etc/actiondock/repos.json`。Compose 将项目内的 `server/config/` 挂载到该目录。`sync` 遇到脏工作区会停止，遇合并冲突会中止合并并返回冲突文件；系统知识仓使用快进同步。首次没有检查点时，`list` 返回需要初始盘点的 `initial` 状态。

## 常用调用

```bash
ad run maintenance/maintenance.sync --profile skm
ad run maintenance/maintenance.list --profile skm -- \
  path="/srv/workspace/order-service"
```

完成源码与知识核对后，如无需改文档，使用 `list` 返回的 `to` 提交推进检查点：

```bash
ad run maintenance/maintenance.complete --profile skm -- \
  path="/srv/workspace/order-service" \
  commit="<本轮 to 提交哈希>" \
  actionTaken="no_change_needed" \
  summary="已核对受影响的业务契约，现有知识仍有效"
```

若改了文档，先检查链接、工作区及暂存文件，再调用 `publish`；确认推送成功后以 `docs_updated` 推进检查点。当前 `publish` 不内置链接校验或 `docs/knowledge/` 白名单，省略 `files` 时会执行 `git add -A`。具体检查命令见[运维手册](../../../docs/operations.md)。

所有动作的字段与返回值以 [actiondock.json](actiondock.json) 为准。本地开发可在包目录运行 `npm run typecheck` 与 `npm test`。
