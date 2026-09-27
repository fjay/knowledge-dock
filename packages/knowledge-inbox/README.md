# actiondock-knowledge-inbox

[ActionDock](https://github.com/team4u/actiondock) 知识库反馈与追加写入平面，专用于知识库自动维护与反馈闭环架构。

本包运行在服务端，负责收集、检索与归档由人工排障、日常运维及 Agent 排错产生的候选 Markdown 文档。

---

## 核心定位与极简设计原则

| 组件 / 包 | 定位 | 权限模式 | 职责 |
|---|---|---|---|
| `knowledge-workspace` | 工作区能力平面 | 读写受控 | 为维护智能体提供工程检索、受控读写与工作区内终端执行 (`search.rg`, `files.read`, `files.list`, `files.write`, `files.edit`, `bash.exec`)，对外只读由查询视图动作白名单实现 |
| `knowledge-inbox` | 反馈追加平面 | 追加写入 | 收集、检索与归档人工排障及日常维护产生的候选文档 |
| `knowledge-maintenance` | 特权维护平面 | 受控写入 | 双分支代码仓与单分支系统知识仓的同步、待维护扫描与检查点推进 |

### 遵循极简原则
- 高容错正文接收：不搞死板复杂的正则门禁检查，以极高的容错性接收任何 Markdown 正文；
- 服务端三件事原则：受控落盘、简单查询、状态归档。

---

## 核心 Action 规范

### knowledge.collect
- **入口**：`actions/knowledge-collect.ts`
- **功能**：
  - 从 `ctx.config.get("KNOWLEDGE_INBOX_ROOT", "/srv/knowledge-inbox")` 读取根路径（支持环境变量 `KNOWLEDGE_INBOX_ROOT` 与配置，目录不存在自动创建）。
  - 生成安全唯一 ID（例如 `20260924-a1b2c3` 格式的时间戳与短哈希）。
  - 解析 Frontmatter（若有）：保留原有的 `title`、`domain`、`tags`、`repos` 等字段（亦兼容历史文档的 `repo`），追加并覆盖服务端元数据：
    ```yaml
    id: <id>
    created_at: <ISO>
    status: "pending"
    repos:
      - <repo1>
      - <repo2>
    ```
  - 若输入 Markdown 没有 Frontmatter，自动提取首个 H1 标题补上标准 Frontmatter。
  - 生成规范文件名：`<YYYYMMDD-HHmmss>-<shortId>-<safeSlug>.md`（严格防范路径穿越）。
  - 安全写入 `<inboxRoot>/pending/<filename>`。
  - 返回 `{ id, filename, path, status: "pending" }`。

### knowledge.list
- **入口**：`actions/knowledge-list.ts`
- **功能**：
  - 扫描 `<inboxRoot>/pending` 或 `<inboxRoot>/processed` 下的 `.md` 文件。
  - 支持筛选入参 `status`：`"pending"`（默认）、`"processed"`、`"all"`。
  - 支持按年份筛选入参 `year?: string`（例如 `"2026"`），支持仅扫描该年份目录与结果过滤，亦保持兼容扫描全量年份。
  - 支持按代码仓筛选入参 `repo?: string`（按仓库标识筛选，只要候选文档包含该仓库即命中）。
  - 读取文件头部的 Frontmatter 与目录层级，提取 `id`、`year`、`title`、`domain`、`status`、`tags`、`repos`、`createdAt`、`archivedAt`、`resolution`、`archiveNote` 等字段。
  - 按创建时间倒序排序返回 `{ items: [...] }`。

### knowledge.archive
- **入口**：`actions/knowledge-archive.ts`
- **功能**：
  - 在 `pending/` 目录中定位对应文件（支持候选文档 `id` 或完整文件名匹配）。若文件不存在抛出 404 错误。
  - 提取归档年份 `<year>`（优先从候选文档 `createdAt` 或 `id` 前缀提取 4 位年份，fallback 为当前 UTC 年份）。
  - 支持归档决策入参 `resolution`（默认 `"accepted"`）：
    - `accepted`：采纳合入正式知识库
    - `duplicate`：已有重复知识
    - `rejected`：无效或过时
    - `insufficient_evidence`：缺少关键排障日志或佐证
  - 目标目录：`<inboxRoot>/processed/<year>/<resolution>/`，自动递归创建目录。
  - 更新文件 Frontmatter：
    ```yaml
    status: "processed"
    resolution: <resolution>
    archived_at: <ISO>
    archive_note: <note> # 若提供
    ```
  - 将文件原子移动到目标目录。
  - 返回 `{ id, fromPath, toPath, resolution, status: "archived", year }`。

---

## 存储目录结构

知识候选文档的生命周期流转目录结构如下：

```text
/srv/knowledge-inbox/
├── pending/                                  # 待审查/待合入候选文档
│   ├── 20260924-112345-a1b2c3-redis-failover.md
│   └── 20260924-113000-d4e5f6-k8s-eviction.md
└── processed/                                # 已归档文档（按年份分层）
    └── 2026/                                 # 年份目录
        ├── accepted/                         # 已采纳知识
        │   └── 20260924-112345-a1b2c3-redis-failover.md
        ├── duplicate/                        # 重复文档
        ├── rejected/                         # 拒绝采纳
        └── insufficient_evidence/            # 证据不足待补充
```

---

## 配置说明

支持通过 ActionDock 项目配置或操作系统环境变量进行配置：

| 配置项 | 类型 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|---|
| `KNOWLEDGE_INBOX_ROOT` | `string` | `KNOWLEDGE_INBOX_ROOT` | `/srv/knowledge-inbox` | 候选知识库根存储路径 |

---

## 快速使用示例

### 收集排障候选知识 (`knowledge.collect`)
```bash
# 收集排障候选知识（通过文档自带 Frontmatter 指定关联仓库）
ad run knowledge.collect \
  content="---\ntitle: Nginx 502 排查经验\nrepos:\n  - order-service\n---\n\n检查 php-fpm 进程数与 backlog 连接队列。" \
  filename="nginx-502-fix"

# 多仓跨域候选知识收集
ad run knowledge.collect \
  content="---\ntitle: 分布式事务补偿异常\nrepos:\n  - order-service\n  - payment-service\n---\n\n排查 order-service 与 payment-service 之间的消息丢失。" \
  filename="saga-compensation"
```

### 查看待处理列表 (`knowledge.list`)
```bash
# 查询 pending 候选文档
ad run knowledge.list

# 按代码仓筛选候选文档
ad run knowledge.list repo="order-service"

# 查询所有已归档文档
ad run knowledge.list status="processed"

# 按年份过滤查询
ad run knowledge.list status="processed" year="2026"
```

### 归档处理候选知识 (`knowledge.archive`)
```bash
# 采纳合入
ad run knowledge.archive \
  id="20260924-a1b2c3" \
  resolution="accepted" \
  note="已合并至运维通用排障文档"

# 标记为重复文档
ad run knowledge.archive \
  id="20260924-112345-a1b2c3-redis-failover.md" \
  resolution="duplicate" \
  note="与 KB-20260901-01 内容重合"
```

---

## 本地开发与测试

```bash
# 安装依赖
npm install

# 生成 TypeScript 强类型定义
ad generate types

# 运行类型检查
npm run typecheck

# 校验 ActionDock 配置与 Schema 规范
ad validate

# 执行全量单元测试
npm test

# 注册至本机全局 ActionDock 注册表
ad link
```

---

## 许可证

MIT
