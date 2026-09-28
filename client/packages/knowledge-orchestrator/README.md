# actiondock-knowledge-orchestrator

[ActionDock](https://github.com/team4u/actiondock) 本地客户端编排包，专用于知识库自动化批量维护与三阶段流水线调度。

本包属于本地客户端控制平面，仅在本地宿主机或本地智能体终端运行，绝不打包进云端容器镜像。

---

## 核心定位与架构分工

| 组件 / 包 | 定位 | 运行环境 | 职责 |
|---|---|---|---|
| `knowledge-workspace` | 工作区能力平面 | 云端容器（443 端口） | 为智能体提供工程检索、受控读写与工作区内终端执行 (`search.rg`, `files.read`, `files.list`, `files.write`, `files.edit`, `bash.exec`, `links.verify`) |
| `knowledge-inbox` | 反馈追加平面 | 云端容器（443 端口） | 收集人工排障与补充候选文档 (`knowledge.collect`, `knowledge.list`, `knowledge.archive`) |
| `knowledge-maintenance` | 特权原子维护平面 | 云端容器（443 端口） | 双分支代码仓与单分支系统知识仓的同步、待维护扫描、发布与检查点推进 (`maintenance.sync`, `maintenance.list`, `maintenance.publish`, `maintenance.complete`) |
| `knowledge-orchestrator` | 本地客户端编排平面 | 本地宿主机 / 终端 | 批量扫描、任务模版渲染、外部智能体异步派发、检查点状态轮询、待审池串行消费与三阶段流水线调度 (`orchestrator.pipeline`) |

---

## 核心 Action 列表

### `orchestrator.pipeline`

- **入口**：`actions/pipeline.ts`
- **功能**：
  - 编排并驱动单代码仓增量巡检、系统知识库全局聚合与待审池串行消费三阶段流水线。
  - 支持 `dryRun` 预演模式，仅扫描远端变更并渲染派发命令，不实际触发执行。
  - 支持自动分支同步与冲突自愈（`autoSync`）：单仓巡检前自动执行分支同步探测，检测到合并冲突时自动派发消解智能体并轮询等待自愈，消解成功后平滑推进后续核验。
  - 支持外部智能体命令模版插值（`{{repo}}`、`{{prompt}}`、`{{commitsSummary}}` 等）与安全引号转义。
  - 自动轮询远端检查点推进状态，超时自动终止并生成 Markdown 结算报告。
  - 支持本地实时日志文件追加（`logFile`），便于使用 `tail -f` 流式追溯。
  - **配套规程**：`playbooks/scheduled-maintenance.md`（规程标识符：`scheduled-maintenance`）。

---

## 本地执行命令实战范式

**重要说明**：
`orchestrator.pipeline` 是本地 Action，在本地终端执行，**命令行绝对不带** `--profile skm` **控制选项**！
`profile="skm"` 仅仅作为数据入参在双短横线（`--`）后传递给内部远程查询。

- 预演预览：
  ```bash
  ad run orchestrator.pipeline -- dryRun:=true
  ```

- 正式流水线执行：
  ```bash
  ad run orchestrator.pipeline -- profile="skm" \
    logFile="/var/log/knowledge-pipeline.log" \
    dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"' \
    timeout:=15 interval:=10
  ```

- 本地后台守护进程执行：
  ```bash
  nohup ad run orchestrator.pipeline -- profile="skm" \
    logFile="/var/log/knowledge-pipeline.log" \
    dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"' \
    > /var/log/pipeline-stdout.log 2>&1 &
  ```

- 本地流式日志追溯：
  ```bash
  tail -f /var/log/knowledge-pipeline.log
  ```

---

## 开发与质量规范

本包严格遵循 ActionDock 规范红线：
- **进程隔离**：所有系统命令与子进程调度均通过 `ctx.process.run` 驱动，并绑定超时时限与 `ctx.signal`。
- **结构化日志**：使用 `ctx.log.info / warn / error / debug` 输出事件，支持可选的 `logFile` 实时时序落盘。
- **强类型与契约**：基于 Schema v2 规范编写 `actiondock.json`，通过 `ad generate types` 导出类型。
- **确定性测试**：利用 `@actiondock/testing` 的 `FakeProcessDriver` 进行纯内存确定性测试。

### 运行测试与验证

```bash
# 校验 ActionDock Action 规范与模式契约
ad validate

# 校验 ActionDock Playbook 规程
ad playbook validate

# 运行 TypeScript 类型检查
npm run typecheck

# 执行全量单元测试
npm test
```
