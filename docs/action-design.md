# 动作体系设计思考：从踩坑推导到受控智能体工作空间

> 本文不罗列枯燥的接口字典，而是完整记录我们在设计 knowledge-dock 动作体系与选型 ActionDock 底座过程中的真实推演历程：我们遇到过哪些工程陷阱、为何否决了那些看似显而易见的传统方案，以及如何逐步构建出一套让 AI 智能体稳定运行的确定性工作空间。

---

## 认知的质变：面对的操作者不再是人类

构建知识库系统时，绝大多数工程师的第一直觉是沿用人类习惯的工具：终端、Shell 脚本、SSH 会话或简单的 HTTP 接口。因为人类天然具备常识、上下文联想能力、对误操作后果的生理畏惧，以及在混乱输出中一眼抓住关键信息的容错本能。

但当我们真正尝试让 AI 智能体（包括自主维护智能体与只读排障助手）常态化接管知识维护时，原有的交互假设几乎全部碰壁：

- **上下文预算极其昂贵且脆弱**：人类面对几万行未分页的检索日志，可以通过视觉扫视跳过；而智能体必须将所有输出灌入上下文窗口，一次未经节制的全文检索会瞬间打爆 Token 预算，带来注意力稀释甚至推理中断；
- **自回归模型天然缺乏物理敬畏**：在智能体的注意力计算中，修改一行文档和执行一次主干代码删除没有本质区别。依赖提示词里的温柔告诫根本阻挡不住概率采样下的误操作，破坏性动作必须在工程底层被物理焊死；
- **概率生成极易产生参数幻觉**：面对深层嵌套的接口入参，模型极易凭空捏造字段或传递越界数值，导致脆弱的通信链路频频中断。

这使我们意识到：**不能把人类使用的工具直接丢给智能体。必须通过强约束的确定性工程系统，去驾驭概率采样的智能体模型。**

---

## 方案的推导：否决四条直觉路线的心路历程

在确定动作体系前，我们推演并否决了四种看似最直接的实现路径：

- **为什么不直接在本地跑单机维护脚本**：
  - 最初的想法是在工程师本地克隆代码并运行脚本。但很快发现，企业级工程涵盖数十个代码仓，本地单机的磁盘、网络与算力根本吃不消多仓的高频镜像拉取与分析；
  - 更致命的是事实源漂移：每个人本地维护一份，线上只读排障助手和外部流水线根本无法共享最新的权威视界；
  - 本地环境天然缺乏网络权限沙箱，智能体一旦失控，本地开发者的私有密钥与非公开代码将面临全量泄露风险。

- **为什么不在服务器上直接开 SSH 终端给智能体用**：
  - 既然需要集中式环境，那在远端开个容器并通过 SSH 登录执行命令是否可行？实践证明这是一场灾难；
  - 终端返回的是混杂 ANSI 颜色转义符、不规则换行和非标准退出码的字符流。智能体需要消耗高昂的推理成本去反序列化文本并猜测执行状态；
  - 会话授予的是系统底层 Shell 权限，一旦失控即可横向穿透整个系统；
  - 生产环境的 22 端口通常受到堡垒机与防火墙严防死守，根本不适合作为频繁调用的自动化接口；
  - 在字符终端下，我们根本无法在服务端构建不可绕过的质量门禁，所有防护都只能退化为脆弱的提示词约定。

- **为什么不手写一套通用的网络服务**：
  - 那么手写一个包含若干 HTTP 接口的服务呢？看似可行，但维护代价极其沉重；
  - 消费端不仅有 HTTP 调用，客户端调度流水线需要本地命令行无缝调试，智能体需要便携的技能资产。如果手写服务，针对每种形态都需要编写大量的路由分发与适配胶水代码；
  - 要在统一端口上划分普通只读权限与特权维护权限，开发者必须手工编写复杂的认证中间件与接口过滤逻辑，安全漏洞防不胜防；
  - 引入传统 Web 框架还会绑定沉重的转译构建工具链与繁杂的第三方依赖，违背我们追求的极简轻量理念。

- **为什么不引入外置专有知识库或数据库**：
  - 将知识抽离存入独立的向量数据库或文档存储，立刻打破了「代码是唯一事实源」的核心原则；
  - 代码分支重构时，外置数据库无法同步感知版本变迁，知识再次与代码脱节；
  - Git 原生具备基于提交哈希的增量扫描能力与完整的审计追踪链，没有任何理由弃用成熟的 Git 去徒增系统状态复杂度。

---

## 底座的破局：ActionDock 框架带来的关键支撑

在排除上述路径后，底座框架 ActionDock 的核心能力恰好精准击中了我们的痛点：

- **原生单端口虚拟视图消除了网络复杂度**：
  - 我们要求服务端在 443 统一端口下运行，既对外提供安全的只读服务，又对内支持完整的维护闭环；
  - ActionDock 原生支持单端口虚拟视图技术，仅根据请求头中的令牌自动划分视界与白名单，免除了我们在前面挂载反向代理网关或自写复杂中间件的痛苦，架构极致纯粹；
- **受控流式进程构筑了上下文物理防线**：
  - 当智能体调用 ripgrep 全文检索或 Git 操作时，ActionDock 进程驱动在底层实时监控输出缓冲区与执行耗时；
  - 一旦匹配达到预设配额立即终止进程并显式标记截断，从系统底层彻底消除大仓检索打爆模型上下文的风险；
- **Node.js 原生极简底座消除了工程包袱**：
  - 框架基于 Node.js（版本大于等于 24.12.0），原生利用类型擦除直接执行 TypeScript，结合内置轻量 HTTP 服务，完全省去了 Babel、Webpack 等编译打包步骤，冷启动毫秒级，容器镜像极其轻快；
- **扁平调用协议消除了模型参数幻觉**：
  - 框架采用扁平键值赋值与有限数递归校验，在底层协议上直接拦截原型污染与非法类型，智能体不需要构造脆弱的多层嵌套 JSON，调用成功率大幅提升。

---

## 闭环的设计：把硬性门禁焊死在动作契约中

有了底座支撑，我们开始将核心业务规程固化为确定性的动作门禁，彻底告别对智能体自觉性的依赖：

- **权限控制：单端口虚拟视图权限隔离**
  - 统一规范表述为「单端口虚拟视图权限隔离」（Virtual Views），基于只读查询令牌 `ACTIONDOCK_TOKEN` 与特权维护令牌 `ACTIONDOCK_AGENT_TOKEN` 在 443 端口实现细粒度动作暴露隔离；
  - 我们把能力严格切分为两重逻辑视界：
    - 查询视界（`sk`）：仅暴露工作区检索 [search-rg.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/search-rg.ts)、分段读取 [files-read.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-read.ts)、目录浏览 [files-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-list.ts) 与候选投递 [knowledge-collect.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-collect.ts)；外部查询者与排障助手没有任何文件修改或代码提交能力；
    - 维护视界（`skm`）：面向受信任网络内的维护智能体与调度器，才开放文件受控写入 [files-write.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-write.ts)、精准编辑 [files-edit.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-edit.ts)、受限终端执行 [bash-exec.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/bash-exec.ts) 与 Git 维护闭环动作。
- **仓储治理：双分支隔离治理模型**
  - 统一规范表述为「双分支隔离治理模型」，主干业务分支与知识分支解耦，遇冲突安全中止并由智能体进行语义消解；
  - 生产业务分支（如 `main` 或 `release`）由人类团队维护，专属知识分支（`docs`）承载知识文档；
  - 在分支同步动作 [maintenance-sync.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-sync.ts) 中，若检测到代码合并冲突，程序严禁私自裁决或强推，而是立即执行 `git merge --abort` 退出并保持干净状态，交由智能体进行语义消解，杜绝破坏生产代码。
- **增量控制：检查点基线推进机制**
  - 统一规范表述为「检查点基线推进机制」（基于提交哈希的增量扫描基准）。无文档变更时推进检查点的技术必要性在于：无论代码变更是否触发文档改动，推进基线均为标记该批次提交已通过完整审计与评估的唯一凭据；若不推进检查点，后续维护将持续对已审计代码重复发起冗余比对与全量扫描，破坏增量闭环收敛性并带来不必要的计算开销；
  - 扫描动作 [maintenance-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-list.ts) 精准筛选未审提交；智能体核验完毕后，通过推进动作 [maintenance-complete.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-complete.ts) 推进检查点哈希，确保增量闭环收敛。
- **经验流转：排障经验待审池**
  - 统一规范表述为「排障经验待审池」，规范候选经验结构化采集、特权审查提炼与决议归档留痕闭环；
  - 我们明确将候选文档定位于贡献单元，而非正式知识存储单元；
  - 外部经验先通过投递动作 [knowledge-collect.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-collect.ts) 写入待审池缓冲；特权智能体通过列表动作 [knowledge-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-list.ts) 审阅并结合源码求证属实后合入正式文档，最后调用归档动作 [knowledge-archive.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-archive.ts) 留存历史，彻底阻断主观孤证污染正式知识库。
- **质量门禁与业务代码防污染红线**
  - 统一规范表述为「零断链门禁」（`links.verify` 就地自愈）与「业务代码防污染红线」（严格收敛在 `docs/knowledge/` 目录）；
  - 零断链门禁：正式提交前强制调用断链校验 [links-verify.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/links-verify.ts)，若存在断链立即阻断放行，智能体就地调用精准编辑 [files-edit.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-edit.ts) 修复至断链数为零；
  - 业务代码防污染红线：文档发布动作 [maintenance-publish.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-publish.ts) 在提交前强行校验暂存区改动范围，一旦检测到改动超出 `docs/knowledge/` 目录，立即执行全量回滚并阻断发布。

---

## 调度的巧思：本地控制平面与远端事实平面的双平面协同

另一个经过反复推演的设计，是流水线调度器的位置：**为什么调度器不在云端常驻，而是纯本地运行？**

- **统一规范表述为「客户端控制平面」**（纯本地控制动作，命令行严禁附加 `--profile` 控制选项）；
- **守护服务端无状态高吞吐**：
  - 流水线调度动作 [pipeline.ts](file:///root/code/knowledge-dock/client/packages/knowledge-orchestrator/actions/pipeline.ts) 需要按清单轮询多仓并长周期等待智能体回包。若将调度器打包扔到远端服务器运行，服务端将沦为有状态的批处理队列，连接与内存被长期霸占，外部查询响应将受到严重干扰；
- **本地环境与任务派发上下文的不可替代性**：
  - 调度器需要在本地根据执行机环境动态渲染派发模板（如通过 `dispatchCmd` 参数在本地拉起特定的子智能体命令），并落盘本地日志文件（`logFile`）便于开发者实时观测；远端容器无法感知这些本地特定上下文；
- **故障扩散半径的物理隔离**：
  - 本地流水线由于网络超时或单仓脚本异常退出，故障严格局限在本地单次会话中，远端 443 服务中枢依然平稳提供只读与维护服务。

这里体现了 ActionDock 在命令行设计上的精妙契约：
- 双短横线前的 `--profile` 是框架级控制选项（语义为「将本动作整体打包发往远端执行」），调度器在本地运行，命令行严禁附加该选项；
- 双短横线后的 `profile="skm"` 仅仅是普通数据入参（指示本地调度器下游连接远端哪个特权维护视图）；
- 本地标准执行范式：
  ```bash
  ad run orchestrator.pipeline -- profile="skm" \
    logFile="/var/log/knowledge-pipeline.log" \
    dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"' \
    timeout:=15 interval:=10
  ```

---

## 动作能力矩阵

系统将端到端流程解构为清晰的原子动作矩阵：

| 动作标识符 | 所在子包 | 运行视界 / 平面 | 入口实现文件 | 核心职责 |
|---|---|---|---|---|
| `workspace/search.rg` | `knowledge-workspace` | 查询视界（`sk`） / 维护视界（`skm`） | [search-rg.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/search-rg.ts) | 基于 ripgrep 执行全文流式检索，受配额与智能截断保护 |
| `workspace/files.read` | `knowledge-workspace` | 查询视界（`sk`） / 维护视界（`skm`） | [files-read.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-read.ts) | 文件安全分段读取，防范路径穿越与行数超限 |
| `workspace/files.list` | `knowledge-workspace` | 查询视界（`sk`） / 维护视界（`skm`） | [files-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-list.ts) | 受控目录树层级与文件清单遍历 |
| `workspace/files.write` | `knowledge-workspace` | 维护视界（`skm`） | [files-write.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-write.ts) | 受控文件全量安全写入与目录自动创建 |
| `workspace/files.edit` | `knowledge-workspace` | 维护视界（`skm`） | [files-edit.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-edit.ts) | 基于精确字符串匹配的文件就地精准编辑 |
| `workspace/bash.exec` | `knowledge-workspace` | 维护视界（`skm`） | [bash-exec.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/bash-exec.ts) | 受限工作区内部的原生命令受控执行与状态捕获 |
| `workspace/links.verify` | `knowledge-workspace` | 维护视界（`skm`） | [links-verify.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/links-verify.ts) | 零断链门禁校验，静态扫描相对路径与锚点 |
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
