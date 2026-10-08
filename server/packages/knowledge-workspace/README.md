# 工作区动作包

`knowledge-workspace` 在配置的 `WORKSPACE_ROOT` 下提供检索、文件操作、终端执行与 Markdown 链接检查。服务端默认根目录为 `/srv/workspace`。查询视图只暴露检索、读取和目录浏览；编辑、终端与链接检查由维护视图使用。

| Action | 主要入参 | 用途 |
|---|---|---|
| `search.rg` | `pattern`；可选 `paths`、`glob`、`maxResults` 等 | 基于 ripgrep 搜索文本 |
| `files.read` | `path`；可选 `startLine`、`maxLines` | 分段读取 |
| `files.list` | 可选 `path`、`depth`、`hidden` | 浏览目录 |
| `files.write` | `path`、`content` | 创建或覆盖文件 |
| `files.edit` | `path`、`targetContent`、`replacementContent` | 精确替换文本 |
| `bash.exec` | `command`；可选 `cwd`、`timeoutMs` | 在指定工作目录运行命令 |
| `links.verify` | 可选 `path`、`checkAnchors`、`ignoreDirs` | 报告 Markdown 断链 |

入参、默认值和返回结构以 [actiondock.json](actiondock.json) 为准。路径会经过工作区路径策略检查；`bash.exec` 只校验工作目录，命令本身仍可调用容器中的其他资源，因此它是特权动作。

## 正文与元数据输出

`files.read` 和 `bash.exec` 在清单中将 `content` 声明为默认正文。使用支持声明式正文输出的 ActionDock CLI 同步调用时，正文保留真实换行输出到标准输出，其余字段以 JSON 输出到标准错误流：

- `files.read` 的元数据包含文件路径、行号范围、`hasMore` 和可选截断标记。
- `bash.exec` 的元数据包含子进程 `exitCode` 和截断标记；子进程退出码仍是业务结果字段，不会自动成为 CLI 退出码。
- 其他工作区动作保持完整结构化输出。需要程序化消费时，在 `--` 前添加 `--json` 获取完整执行信封，不应用正文分流。标准错误流还可能包含日志，不应作为独立的数据协议解析。

## 常用调用

```bash
ad run workspace/search.rg --profile sk -- pattern="PaymentStatus"
ad run workspace/files.read --profile sk -- \
  path="order-service/docs/knowledge/overview.md" startLine:=1 maxLines:=80
ad run workspace/files.read --profile sk --json -- \
  path="order-service/docs/knowledge/overview.md" startLine:=1 maxLines:=80
ad run workspace/files.list --profile sk -- path="order-service" depth:=2
ad run workspace/bash.exec --profile skm -- \
  command="git diff" cwd="order-service"
ad run workspace/links.verify --profile skm -- \
  path="order-service/docs/knowledge"
```

`links.verify` 返回断链明细供维护者修复，不会自动写入文件。编辑前应先读取目标内容并确认匹配范围；大段 Markdown 输入可使用 ActionDock 的 `--input-file` 模式，减少终端转义错误。

本地开发可在包目录运行 `npm run typecheck` 与 `npm test`。文档专项说明见[架构与边界](../../../docs/architecture.md)和[运维手册](../../../docs/operations.md)。
