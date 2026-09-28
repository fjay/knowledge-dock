# 排障经验待审池动作包

`knowledge-inbox` 将人工经验作为候选 Markdown 存储在 `KNOWLEDGE_INBOX_ROOT`。默认目录为 `/srv/knowledge-inbox`，其中 `pending/` 保存待审候选，`processed/<年份>/<决议>/` 保存已归档候选。候选不会自动进入正式 Git 知识库。

| Action | 视图 | 用途 |
|---|---|---|
| `knowledge.collect` | `sk`、`skm` | 接收 `content`，生成候选编号、文件名和时间 |
| `knowledge.list` | `skm` | 按 `status`、`repo` 或 `year` 查看候选 |
| `knowledge.archive` | `skm` | 用 `id` 与 `resolution` 记录决议并归档 |

`knowledge.collect` 的 `filename` 是可选建议名；服务端会生成实际文件名。它只检查内容是否非空，不校验事实、查重或强制候选格式。投递前应按[知识格式](../../../docs/knowledge-model.md)整理证据，并经过贡献者确认。

## 常用调用

```bash
ad run knowledge/knowledge.collect --profile sk -- \
  content="# 支付超时排障候选" filename="payment-timeout"

ad run knowledge/knowledge.list --profile skm -- status="pending"

ad run knowledge/knowledge.archive --profile skm -- \
  id="<候选标识>" resolution="duplicate" \
  note="现有排障手册已有相同且仍有效的说明"
```

归档决议可以是 `accepted`、`duplicate`、`rejected` 或 `insufficient_evidence`。`archive` 只移动候选并写入决议，不会修改正式文档；采纳时应先完成正式知识更新和发布。完整参数见 [actiondock.json](actiondock.json)。

本地开发可在包目录运行 `npm run typecheck` 与 `npm test`。端到端处理顺序见[维护流程](../../../docs/workflow.md)。
