# 动作体系设计与 ActionDock 底座工程解析

> 本文档阐述 knowledge-dock 动作体系设计背景、技术方案选型推导，以及底层 ActionDock 框架的技术赋能与双平面协同机制。

---

## 核心设计出发点：面向智能体的工程约束

knowledge-dock 的核心使用者不是人类工程师，而是各类自主运行的 AI 智能体（受控维护智能体与只读排障助手）。智能体的物理特性决定了系统必须具备刚性工程防线：

- **上下文窗口预算硬约束**：大型代码仓的全文检索或文件读取若不加节制，瞬时输出的超长文本会直接击穿智能体的 Token 预算，导致注意力稀释或推理截断；系统必须由服务端实施强制分段与配额截断；
- **破坏性操作不可逆**：大模型缺乏对文件删除、分支强推等后果的物理敬畏，提示词约束无法提供百分之百的可靠性；系统防线必须硬编码在服务端逻辑中，杜绝任何越权与误改；
- **自回归生成易产生参数幻觉**：深层嵌套对象与松散类型极易导致智能体传参漂移；系统通信必须依赖强类型扁平契约与机器可读的结构化错误。

---

## 方案选型对比与反向推导

在系统演进过程中，对以下常见工程方案进行了对比推导并最终予以排除：

- **为什么不采用纯本地单机方案**：
  - 本地维护无法为线上排障助手与外部流水线提供统一事实源；
  - 几十个代码仓的全量镜像克隆与高频检索对本地宿主机资源带来过高负担；
  - 本地环境天然缺乏网络权限沙箱，智能体容易越权读取私有凭据与非公开代码。
- **为什么不采用直接终端与远程会话（Bash / SSH）**：
  - 字符流输出混杂 ANSI 转义符与非标准退出状态，智能体解析容错成本极高；
  - 会话授予的是系统底层 Shell 权限，一旦失控即可横向穿透整个操作系统；
  - 企业专有 22 端口通常受到防火墙与跳板机策略严管，难以向外部轻量调度器开放；
  - 无法在服务端构筑硬性质量门禁，所有防御完全依赖脆弱的提示词约定。
- **为什么不采用手写通用网络服务**：
  - 面对命令行、调度流水线与智能体技能等多端消费，需手工维护大量协议适配胶水代码；
  - 需要自行手写复杂的认证中间件与接口动态过滤逻辑，容易产生安全漏洞；
  - 缺乏针对大模型交互的参数防幻觉校验；
  - 引入传统 Web 框架往往绑定沉重的转译构建工具链与运行时依赖，违背极简原生哲学。
- **为什么坚持 Git 为单一事实源**：
  - 杜绝外置专有数据库与代码分支脱节造成事实漂移；
  - 完整继承 Git 基于提交哈希的增量扫描、双分支治理与历史审计能力。

---

## ActionDock 底座框架的技术赋能

knowledge-dock 基于 ActionDock 框架构建，其底层能力为本系统提供了极简且高可靠的运行支撑：

- **原生单端口虚拟视图**：
  - 在标准 HTTPS 443 统一端口下，基于请求头令牌原生实现视界隔离，免除前置反向代理网关与复杂的访问控制列表；
  - 服务端基于只读查询令牌挂载查询视界（`sk`），基于特权维护令牌挂载维护视界（`skm`），各自具备独立的包路由与动作白名单。
- **非阻塞流式进程保护**：
  - 针对 ripgrep 与 Git 系统命令，框架内置超时强杀、内存配额硬限制与输出缓冲区监控；
  - 检索输出达到预设配额时立即优雅终止进程并返回截断标识，从系统底层保护智能体上下文。
- **现代 Node.js 原生极简底座**：
  - 基于 Node.js（版本大于等于 24.12.0），利用原生类型擦除直接执行 TypeScript，彻底废除外部编译打包链路；
  - 结合内置的高性能轻量 HTTP 服务，实现零转译、零冗余依赖的极简容器运行时，毫秒级冷启动。
- **面向智能体的调用协议**：
  - 严格采用扁平键值协议与有限数递归校验，内建反原型污染拦截，在协议层根除参数生成幻觉；
  - 全链路统一结构化错误契约，明确透传机器可读错误码，便于智能体自主执行自愈闭环。

---

## 业务动作体系与五大工程硬门禁

基于底层框架能力，knowledge-dock 在服务端固化了五大确定性工程门禁：

- **权限控制**：
  - 统一规范表述为「单端口虚拟视图权限隔离」（Virtual Views），基于只读查询令牌 `ACTIONDOCK_TOKEN` 与特权维护令牌 `ACTIONDOCK_AGENT_TOKEN` 在 443 端口实现细粒度动作暴露隔离；
  - 查询视界（`sk`）仅暴露全文检索 [search-rg.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/search-rg.ts)、分段读取 [files-read.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-read.ts)、目录浏览 [files-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-list.ts) 与候选投递 [knowledge-collect.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-collect.ts)，物理阻断写入与分支修改；
  - 维护视界（`skm`）才开放文件受控写入、精准编辑与 Git 分支治理等特权能力。
- **仓储治理**：
  - 统一规范表述为「双分支隔离治理模型」，主干业务分支与知识分支解耦，遇冲突安全中止并由智能体进行语义消解；
  - 分支同步动作 [maintenance-sync.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-sync.ts) 在合并发生代码冲突时，严禁私自裁决，立即执行 `git merge --abort` 安全退出并退回干净状态，交由智能体进行语义消解。
- **增量控制**：
  - 统一规范表述为「检查点基线推进机制」（基于提交哈希的增量扫描基准）。无文档变更时推进检查点的技术必要性在于：无论代码变更是否触发文档改动，推进基线均为标记该批次提交已通过完整审计与评估的唯一凭据；若不推进检查点，后续维护将持续对已审计代码重复发起冗余比对与全量扫描，破坏增量闭环收敛性并带来不必要的计算开销；
  - 扫描动作 [maintenance-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-list.ts) 筛选未审提交；无论是否更新文档，核验完成后均通过推进动作 [maintenance-complete.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-complete.ts) 坚决推进检查点基线水位。
- **经验流转**：
  - 统一规范表述为「排障经验待审池」，规范候选经验结构化采集、特权审查提炼与决议归档留痕闭环；
  - 确立候选文档是贡献单元而非正式知识存储单元的物理解耦定位；外部经验先通过 [knowledge-collect.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-collect.ts) 缓冲入池，维护智能体通过 [knowledge-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-list.ts) 提取并交叉求证属实后提炼合入正式文档，最后通过 [knowledge-archive.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-archive.ts) 决议归档留痕。
- **质量门禁与业务代码防污染红线**：
  - 统一规范表述为「零断链门禁」（`links.verify` 就地自愈）与「业务代码防污染红线」（严格收敛在 `docs/knowledge/` 目录）；
  - 零断链门禁：文档发布前强制调用断链校验 [links-verify.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/links-verify.ts)，若存在失效相对路径或锚点，智能体就地调用精准编辑 [files-edit.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-edit.ts) 自愈修复至断链数为零；
  - 业务代码防污染红线：发布提交动作 [maintenance-publish.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-publish.ts) 强制核验暂存区改动范围，一旦检测到任何超出 `docs/knowledge/` 目录的代码修改，立即全量回滚并强行阻断发布。

---

## 本地控制平面与远端事实平面的职责边界

系统采用双平面解耦架构，严格划分客户端调度与服务端原子操作的边界：

- **为什么流水线调度器必须纯本地运行**：
  - 统一规范表述为「客户端控制平面」（纯本地控制动作，命令行严禁附加 `--profile` 控制选项）；
  - **守护服务端无状态高吞吐**：流水线调度器 [pipeline.ts](file:///root/code/knowledge-dock/client/packages/knowledge-orchestrator/actions/pipeline.ts) 执行多仓遍历与长时间轮询，若在远端运行会长期占用服务资源，破坏云端事实平面的轻量无状态特性；
  - **本地派发环境不可替代**：调度器需要依赖本地特有的上下文环境（执行机专属密钥、本地命令模板 `dispatchCmd`、本地日志落盘 `logFile`），远端容器无法感知这些上下文；
  - **物理隔离故障扩散半径**：本地调度中断仅影响单次跑批，绝对不会影响云端 443 服务中枢对其他终端的稳定服务。
- **控制选项与数据入参的契约区别**：
  - 双短横线前的 `--profile` 是框架级控制选项（语义为「将本动作打包发往远端服务执行」），调度器在本地运行，严禁使用该选项；
  - 双短横线后的 `profile="skm"` 是普通数据入参（指示本地动作连接远端哪个特权视图），两者语义严格隔离；
  - 本地标准执行范式：
    ```bash
    ad run orchestrator.pipeline -- profile="skm" \
      logFile="/var/log/knowledge-pipeline.log" \
      dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"' \
      timeout:=15 interval:=10
    ```

---

## 动作体系总览表

服务端与客户端动作能力映射矩阵：

| 动作标识符 | 所在子包 | 运行视界 / 平面 | 入口实现文件 | 核心职责 |
|---|---|---|---|---|
| `workspace/search.rg` | `knowledge-workspace` | 查询视界（`sk`） / 维护视界（`skm`） | [search-rg.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/search-rg.ts) | 基于 ripgrep 语法执行代码与文档全文流式检索，受配额与智能截断保护 |
| `workspace/files.read` | `knowledge-workspace` | 查询视界（`sk`） / 维护视界（`skm`） | [files-read.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-read.ts) | 工作区文件安全分段读取，防范路径穿越与行数超限 |
| `workspace/files.list` | `knowledge-workspace` | 查询视界（`sk`） / 维护视界（`skm`） | [files-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-list.ts) | 工作区受控目录树层级与文件清单遍历 |
| `workspace/files.write` | `knowledge-workspace` | 维护视界（`skm`） | [files-write.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-write.ts) | 工作区受控文件全量安全写入与目录自动创建 |
| `workspace/files.edit` | `knowledge-workspace` | 维护视界（`skm`） | [files-edit.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-edit.ts) | 基于精确字符串匹配的工作区文件就地精准编辑 |
| `workspace/bash.exec` | `knowledge-workspace` | 维护视界（`skm`） | [bash-exec.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/bash-exec.ts) | 受限工作区内部的原生命令受控执行与状态捕获 |
| `workspace/links.verify` | `knowledge-workspace` | 维护视界（`skm`） | [links-verify.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/links-verify.ts) | 零断链门禁校验，静态扫描文档相对路径与标题锚点 |
| `knowledge/knowledge.collect` | `knowledge-inbox` | 查询视界（`sk`） / 维护视界（`skm`） | [knowledge-collect.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-collect.ts) | 收集排障经验与人工补充候选，结构化注入待审池 |
| `knowledge/knowledge.list` | `knowledge-inbox` | 维护视界（`skm`） | [knowledge-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-list.ts) | 遍历并过滤待审池中的候选文档元数据与状态 |
| `knowledge/knowledge.archive` | `knowledge-inbox` | 维护视界（`skm`） | [knowledge-archive.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-archive.ts) | 待审池候选决议归档，移至归档目录并记录处理结论 |
| `maintenance/maintenance.sync` | `knowledge-maintenance` | 维护视界（`skm`） | [maintenance-sync.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-sync.ts) | 双分支代码仓与单分支系统仓同步，冲突安全中止 |
| `maintenance/maintenance.list` | `knowledge-maintenance` | 维护视界（`skm`） | [maintenance-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-list.ts) | 扫描仓库自检查点以来的提交增量与受影响文件摘要 |
| `maintenance/maintenance.publish` | `knowledge-maintenance` | 维护视界（`skm`） | [maintenance-publish.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-publish.ts) | 知识分支文档提交与推送，强制校验业务代码防污染红线 |
| `maintenance/maintenance.complete` | `knowledge-maintenance` | 维护视界（`skm`） | [maintenance-complete.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-complete.ts) | 推进检查点基线水位并持久化审计记录 |
| `orchestrator/orchestrator.pipeline` | `knowledge-orchestrator` | 客户端控制平面（纯本地执行） | [pipeline.ts](file:///root/code/knowledge-dock/client/packages/knowledge-orchestrator/actions/pipeline.ts) | 三阶段流水线调度、多仓增量巡检、模板渲染与超时轮询 |

---

## 延伸阅读导航

- **全景架构设计指南**：了解系统核心组件、逻辑架构拓扑与运行时架构，参见 [architecture.md](file:///root/code/knowledge-dock/docs/architecture.md)；
- **核心概念与设计原则**：查阅四大核心设计原则、单端口虚拟视图、双分支隔离模型与检查点机制权威定义，参见 [concepts.md](file:///root/code/knowledge-dock/docs/concepts.md)；
- **端到端流程与生命周期**：掌握代码变更自维护、待审池流转闭环与三阶段流水线调度机制，参见 [workflow.md](file:///root/code/knowledge-dock/docs/workflow.md)；
- **智能体设计与角色矩阵**：了解贡献守门、特权维护、总控编排与只读排障助手的分工协同，参见 [agent-design.md](file:///root/code/knowledge-dock/docs/agent-design.md)；
- **部署与交付实战指南**：获取多仓库配置、双令牌安全基线、私有 Git 免密连接与 Docker 容器部署指引，参见 [deployment.md](file:///root/code/knowledge-dock/docs/deployment.md)；
- **知识运维与质量门禁**：获取检查点基线运维、待审池流转操作、零断链门禁自愈与日志审计手册，参见 [operations.md](file:///root/code/knowledge-dock/docs/operations.md)。
