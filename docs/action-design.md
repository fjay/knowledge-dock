# 动作体系设计与 ActionDock 底座工程解析

> 本文档阐述 knowledge-dock 动作体系设计决策与底层 ActionDock 框架的技术赋能原理。从面向智能体工作空间的第一性原理出发，系统推导为何摒弃纯本地、裸终端及手写网络服务等传统替代方案，深入解析单端口虚拟视图、非阻塞流式保护与现代 Node.js 原生极简底座的工程实现，并定义双平面架构下的确定性工程门禁与端到端协同闭环。

---

## 引言：面向智能体工作空间的第一性原理

- **核心交互客体的根本转变**
  - 传统工程开发工具链（诸如集成开发环境、调试器、命令行终端与维基协作系统）从诞生之初，均默认面向人类工程师设计。人类工程师具备通用常识、长程上下文联想能力、对破坏后果的本能敬畏，以及在非结构化文本与松散规则中自主纠错的容错能力。
  - 在 knowledge-dock 架构体系中，核心交互客体已彻底转变为自主运行的各类智能体程序，具体划分为受控知识维护智能体与只读线上排障助手。这一客体转变使得传统人机交互假设彻底失效。

- **智能体计算模型的物理约束**
  - **刚性上下文预算限制**：智能体大语言模型的上下文窗口存在刚性物理上限。面对大型工程代码库与冗长日志，非受控的输入极易迅速击穿 Token 预算，引发严重的注意力稀释或直接导致模型上下文截断崩溃；
  - **缺乏物理敬畏**：自回归概率模型并不理解操作系统文件删除、分支强制推送或系统级崩溃的物理现实后果。在没有硬性工程防御的情况下，智能体执行破坏性操作（如误删生产源码、破坏主干分支、抹除历史审计）是不可逆的工程灾难；
  - **参数自回归概率生成的幻觉倾向**：智能体本质上是基于概率预测下一个字符的统计模型。面对深层嵌套、弱类型或松散定义的入参，智能体天然存在参数幻觉与字段臆造倾向；
  - **对确定性结构化信号与自愈闭环的强依赖**：智能体的高效协同完全取决于确定性、强类型的输入输出契约。当执行失败或环境异常时，智能体需要标准机器可读的结构化错误码与诊断上下文，以便在有限推理步数内完成自愈闭环，而非面对混杂各色 ANSI 转义字符的非结构化终端流。

- **架构终极目标：确定性工程系统驾驭概率性计算**
  - knowledge-dock 动作体系的终极目标，是通过严格的确定性工程系统为概率性智能体模型构筑坚固防线。通过物理硬隔离、流式配额截断、模式校验与硬门禁拦截，将不可控的概率自回归计算牢牢约束在确定性、可验证、自收敛的工程轨道之内。

---

## 架构反向推导：为什么否定传统替代选型

在系统架构演进过程中，曾对主流工程实现路径进行深度推演与实验比对，最终均予以明确否定。

- **为什么否定纯本地一体化架构**
  - **统一事实源瓦解**：若将代码与知识全流程闭环寄生于开发者或智能体的纯本地机器，各节点在本地维护独立副本，代码分支视界漂移不可避免，知识版本割裂，企业级单一事实源随之瓦解；
  - **本地大仓资源瓶颈**：现代企业级工程往往涵盖数十乃至上百个服务代码仓与海量提交历史，本地单机磁盘、网络带宽与内存计算资源根本无法承载多仓高频全量拉取与深度语法分析；
  - **本地权限沙箱缺失**：本地执行环境天然缺乏统一的凭据隔离与细粒度动作暴露边界，极易将本地开发者的私有密钥、凭证配置与非公开代码意外暴露给第三方智能体进程。

- **为什么摒弃裸终端交互**
  - **上下文瞬时击穿风险**：在裸终端环境下，智能体若执行诸如全局搜索或无分页文件读取，瞬时吐出的数万行非结构化文本会直接打爆上下文 Token 预算，造成推理中断或产生严重截断幻觉；
  - **破坏性行动缺乏硬性防御**：依赖系统提示词向智能体发出禁止修改生产代码或严禁强制推送等软约束，根本无法杜绝概率模型在高推理压力或复合任务下的误操作，物理不可逾越的权限墙是唯一可靠的防线；
  - **全量系统权限暴露**：单一终端会话或 SSH 连接直接暴露底层操作系统的任意命令执行权与全量目录树，智能体一旦失控即可横向穿透系统各层级，造成灾难性安全风险；
  - **机器消费成本高昂**：裸终端输出是非结构化的字符流，夹杂终端颜色转义符、警告文本与不一致的系统退出码。智能体必须消耗昂贵的推理算力猜测执行结果，容错与纠偏成本极高。

- **为什么摒弃手写传统通用网络服务**
  - **多形态交付引发胶水代码膨胀**：为了同时支持外部排障只读调用、本地命令行工具调试与智能体批量调度，手写传统网络服务需要维护庞大的路由分发、报文编解码与参数适配胶水层，维护成本成倍激增；
  - **缺乏针对智能体交互的原生防幻觉校验**：手写通用网络拦截中间件往往局限于基础字段检查，缺乏针对大模型多级嵌套、深层原型链污染与动态上下文截断的原生防御机制，极易因参数微小形变导致服务崩溃；
  - **重型外部依赖违背极简原生工程哲学**：引入传统通用 Web 框架往往绑定沉重的转译构建工具链与繁杂的第三方依赖，不仅拉长冷启动时间，更增加了运行时攻击面与维护脆弱性。

- **为什么摒弃脱离代码的外置专有数据存储**
  - **单一事实源原则破坏**：外置独立数据库与 Git 代码仓库形成两套脱节的事实系统，业务代码重构时外置知识无法同步版本感知，必然导致知识事实再次脱节；
  - **审计与追溯能力缺失**：放弃 Git 即放弃了基于提交哈希的增量扫描能力、双分支治理机制以及细粒度的代码变更追溯审计链；
  - **运维开销与状态维护代价高昂**：引入专有外部状态存储服务显著增加基础设施部署复杂度与故障点，背离极简与轻量至上的核心工程原则。

---

## 基础设施底座：ActionDock 框架的精准赋能

knowledge-dock 全面基于 ActionDock 框架构建，借助其核心基础设施能力，实现极简、安全且高吞吐的智能体服务基座。

- **原生单端口虚拟视图引擎**
  - ActionDock 原生提供单端口虚拟视图技术，使服务端在统一的标准 HTTPS 443 端口下，仅根据请求鉴权令牌将服务划分为完全隔离的逻辑视界；
  - 彻底免除前置反向代理网关与复杂的访问控制列表中间件，架构拓扑收敛至最简单端口结构，根除多端口暴露与网络跨域困扰；
  - 在容器启动自举脚本 [entrypoint.sh](file:///root/code/knowledge-dock/server/entrypoint.sh) 中，通过动态生成单端口视图配置，基于只读查询令牌 `ACTIONDOCK_TOKEN` 挂载 `sk` 只读视界，基于特权维护令牌 `ACTIONDOCK_AGENT_TOKEN` 挂载 `skm` 特权视界，两套视界具备各自独立的包路由与动作白名单，实现物理级权限硬隔离。

- **非阻塞流式进程保护**
  - 集成底层系统命令（包括 ripgrep 全文检索与 Git 仓库操作）调度，通过 ActionDock 进程控制原语构筑全方位的上下文安全屏障；
  - 在检索实现文件 [search-rg.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/search-rg.ts) 中，通过 `ctx.process.start` 异步启动子进程，配合 `limits` 强约束配置（包括空闲超时 `idleMs`、最长生存期 `lifetimeMs` 与输出缓冲区硬上限 `outputBufferBytes`），杜绝失控进程消耗宿主资源；
  - 采用流式分块读取与增量解析，在输出匹配达到设定配额（如 `maxResults`）时即刻通过 `ctx.process.stop` 优雅终止进程，并显式标记截断信号，从底层物理屏障杜绝智能体上下文被意外击穿。

- **现代 Node.js 原生极简底座**
  - 全面基于 Node.js（版本大于等于 24.12.0）运行环境，原生利用类型擦除能力直接执行 TypeScript 源代码文件，彻底废除外部打包与转译构建依赖；
  - 结合内置的高性能轻量 HTTP 服务，实现零预编译、零多余产物、零冗余外部依赖的高纯度运行时；
  - 容器镜像尺寸极致紧凑，冷启动时间缩减至毫秒级，实现真正的高内聚与原生轻量工程哲学。

- **面向智能体的调用协议**
  - 严格采用扁平键值协议约束动作输入输出，规范入参层级与数据形态；
  - ActionDock 在协议层对输入参数执行严格的模式校验、有限数递归检查与敏感原型污染拦截（如防范 `__proto__` 属性篡改），杜绝大模型在复杂嵌套或多维结构中产生参数幻觉与恶意参数注入；
  - 统一全链路错误透传契约，所有错误统一封装为携带明确 HTTP 状态码与机器可读错误标识码的结构化输出，使智能体能够在接收到错误时立即理解失败原因并执行自愈重试。

---

## 业务动作体系：构建确定性工程硬门禁

基于底层基础设施能力，knowledge-dock 构建了由五大核心工程机制组成的业务动作体系，为智能体协作构筑确定性硬门禁。

- **权限控制：单端口虚拟视图权限隔离**
  - 统一规范表述为「单端口虚拟视图权限隔离」（Virtual Views），基于只读查询令牌 `ACTIONDOCK_TOKEN` 与特权维护令牌 `ACTIONDOCK_AGENT_TOKEN` 在 443 端口实现细粒度动作暴露隔离；
  - 只读查询视界（`sk`）：仅向外部排障人员与线上排障助手暴露只读检索与受控追加动作，包括工作区全文检索 [search-rg.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/search-rg.ts)、文件受控分段读取 [files-read.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-read.ts)、目录清单浏览 [files-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-list.ts)，以及排障经验待审池投递追加 [knowledge-collect.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-collect.ts)；严禁暴露任何工作区写入、文件编辑与代码仓提交动作；
  - 特权维护视界（`skm`）：面向受信任网络内的维护智能体与控制平面调度器，开放完整的工作区受控写入 [files-write.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-write.ts)、受控精准编辑 [files-edit.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-edit.ts)、受限原生终端执行 [bash-exec.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/bash-exec.ts)、断链自愈校验 [links-verify.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/links-verify.ts)、双分支同步 [maintenance-sync.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-sync.ts)、代码变更扫描 [maintenance-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-list.ts)、文档发布 [maintenance-publish.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-publish.ts) 与检查点基线推进 [maintenance-complete.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-complete.ts)；
  - 只读端写操作风险被物理阻断在虚拟视图的动作白名单之外，杜绝越权风险。

- **仓储治理：双分支隔离治理模型**
  - 统一规范表述为「双分支隔离治理模型」，主干业务分支与知识分支解耦，遇冲突安全中止并由智能体进行语义消解；
  - 在纳管的代码仓库中，主干业务分支（如 `release` 或 `main`）专用于人类团队日常开发发版，保持纯粹的生产业务代码；专属知识分支（统一为 `docs` 分支）承载该仓的 Markdown 工程知识；
  - 在分支同步实现 [maintenance-sync.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-sync.ts) 执行双分支同步合并时，若发生代码冲突或检测到工作区存在脏状态，程序严禁私自裁决，绝对禁止执行硬重置（`git reset --hard`）或强制推送（`git push --force`），而是立即执行安全中止操作（`git merge --abort`）并退回干净状态，交由智能体进行人工语义消解。

- **增量控制：检查点基线推进机制**
  - 统一规范表述为「检查点基线推进机制」（基于提交哈希的增量扫描基准）。无文档变更时推进检查点的技术必要性在于：无论代码变更是否触发文档改动，推进基线均为标记该批次提交已通过完整审计与评估的唯一凭据；若不推进检查点，后续维护将持续对已审计代码重复发起冗余比对与全量扫描，破坏增量闭环收敛性并带来不必要的计算开销。
  - 系统在增量扫描实现 [maintenance-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-list.ts) 中比对主干分支最新提交与检查点基线提交，仅将存在有效未审提交的仓库筛选为待处理任务；
  - 在智能体完成核验后，通过检查点推进实现 [maintenance-complete.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-complete.ts) 坚决推进检查点基线水位；若判定代码变更纯属内部重构、未引发对外业务契约失效，指定 `actionTaken="no_change_needed"` 推进水位；若更新了文档，指定 `actionTaken="docs_updated"` 推进水位。

- **经验流转：排障经验待审池**
  - 统一规范表述为「排障经验待审池」，规范候选经验结构化采集、特权审查提炼与决议归档留痕闭环；
  - 外部排障人员与日常排障助手所沉淀的故障处置记录，仅作为经验原材料，通过候选采集实现 [knowledge-collect.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-collect.ts) 写入待审池缓冲目录；
  - 候选文档是贡献单元而非正式知识存储单元，两者在物理上完全隔离，杜绝未经验证的推测直接污染正式知识分支；
  - 特权维护智能体通过候选列表实现 [knowledge-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-list.ts) 扫描待审候选，结合源码求证属实后合入对应业务域的正式文档骨架中，最后调用候选归档实现 [knowledge-archive.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-archive.ts) 将候选移至已审归档目录，完成生命周期闭环。

- **质量门禁与业务代码防污染红线**
  - 统一规范表述为「零断链门禁」（`links.verify` 就地自愈）与「业务代码防污染红线」（严格收敛在 `docs/knowledge/` 目录）；
  - **零断链门禁**：在文档正式提交推送前，智能体强制调用断链校验实现 [links-verify.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/links-verify.ts) 对工作区内 Markdown 相对文件引用路径、图片资源及标题锚点进行全量静态分析。若存在断链（`brokenCount > 0`），严禁放行提交，智能体必须调用精准编辑实现 [files-edit.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-edit.ts) 就地修复相对路径或锚点，直至断链数清零；
  - **业务代码防污染红线**：在代码仓库中，文档改动范围严格收敛在 `docs/knowledge/` 目录下。在文档发布实现 [maintenance-publish.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-publish.ts) 阶段核验暂存区改动，一旦检测到任何超出知识文档目录的代码改动，立即全量回滚并强行阻断发布流程，守护生产代码绝对纯洁。

---

## 端到端协同：双平面架构与本地远端职责边界

knowledge-dock 采用清晰的双平面解耦设计，严格划分服务端事实平面与客户端控制平面的工程职责边界。

- **为什么流水线调度器必须纯本地运行**
  - 统一规范表述为「客户端控制平面」（纯本地控制动作，命令行严禁附加 `--profile` 控制选项）；
  - **守护服务端事实平面的无状态与高吞吐**：服务端 443 单端口中枢的核心定位是提供高并发、轻量级、无状态的原子读写能力。多仓库跑批巡检、轮询等待与子任务调度属于高耗时批处理流程，若在服务端常驻运行，必然长期占用网络连接与服务内存，导致正常查询与排障动作响应迟滞；
  - **本地执行机派发环境与上下文的不可替代性**：流水线调度器需要依赖本地运行环境特有的上下文资源，包括开发者或运维主机的私有通信凭据、宿主机子智能体命令模板（通过 `dispatchCmd` 参数在本地唤醒针对单仓定制的各类智能体），以及本地时序任务日志落盘（通过 `logFile` 参数落盘并支持 `tail -f` 实时监控追溯）；
  - **故障扩散半径的物理隔离**：本地流水线若因网络波动、超时或脚本异常中断退出，其故障影响仅局限在本地单次批处理会话中，绝对不会破坏云端 443 服务中枢的运行稳定性，云端只读检索与特权维护能力依然平稳可用。

- **命令行全局控制选项与数据平面入参的底层契约区别**
  - **全局控制选项的控制面契约**：在 ActionDock 命令行设计中，`--profile` 属于客户端 CLI 的全局调度指令（位于双短横线 `--` 之前），其语义是「将本命令整体打包并通过网络发往指定配置名称的远程服务节点执行」。若在执行本地调度器时错误附加全局选项（如 `ad run orchestrator.pipeline --profile skm`），CLI 会尝试将本地专属的编排包发往远端服务器，而远端容器并未链接或暴露 `knowledge-orchestrator` 包，必然导致找不到动作的致命错误；
  - **数据平面入参的数据面契约**：位于双短横线（`--`）之后的 `profile="skm"` 属于动作本身的业务输入数据参数。它指示本地运行的调度器实现文件 [pipeline.ts](file:///root/code/knowledge-dock/client/packages/knowledge-orchestrator/actions/pipeline.ts) 与核心调度库 [pipeline-core.ts](file:///root/code/knowledge-dock/client/packages/knowledge-orchestrator/src/pipeline-core.ts) 在执行下游查询与扫描命令时，将网络请求对准指定的远端配置节点；两者属于不同维度，严禁混淆；
  - 标准本地执行范式示例：
    ```bash
    ad run orchestrator.pipeline -- profile="skm" \
      logFile="/var/log/knowledge-pipeline.log" \
      dispatchCmd='ad run my-agent.dispatch --profile skm -- repo="{{repo}}" prompt="{{prompt}}"' \
      timeout:=15 interval:=10
    ```

- **受控环境下的分析执行与推进自愈闭环**
  - 整个端到端维护流程在严密约束下完成闭环：
    - 阶段一：本地控制平面调度器通过流水线实现 [pipeline.ts](file:///root/code/knowledge-dock/client/packages/knowledge-orchestrator/actions/pipeline.ts) 扫描远端各仓库检查点状态，组装带有代码差异上下文的命令模板，在本地拉起单仓维护智能体；
    - 阶段二：维护智能体在云端单端口特权维护视界下，执行分支同步 [maintenance-sync.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-sync.ts) 并通过全文检索 [search-rg.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/search-rg.ts) 与文件读取 [files-read.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-read.ts) 审计代码变更；
    - 阶段三：依据更新门槛与失效四问判定是否需要更新文档。若需要更新，调用文件写入 [files-write.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-write.ts) 与精准编辑 [files-edit.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-edit.ts) 完成精准文档编写；
    - 阶段四：强制调用断链校验 [links-verify.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/links-verify.ts) 执行零断链门禁校验并就地自愈修复，随后通过发布动作 [maintenance-publish.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-publish.ts) 在业务代码防污染红线保护下提交并推送到远端知识分支；
    - 阶段五：无论是否变更文档，最终坚决调用检查点推进动作 [maintenance-complete.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-complete.ts) 推进检查点基线水位；
    - 阶段六：本地调度器检测到远端检查点水位成功推进，完成单仓结算，进入下一阶段流转。
  - 通过双平面解耦、单端口虚拟视图与严格的硬门禁编排，系统以确定性的工程规范完全驾驭了概率性的智能体维护行为。

---

## 动作体系总览表

服务端与客户端动作能力映射矩阵：

| 动作标识符 | 所在子包 | 运行视界 / 平面 | 入口实现文件 | 核心职责 |
|---|---|---|---|---|
| `workspace/search.rg` | `knowledge-workspace` | 查询视界（`sk`） / 维护视界（`skm`） | [search-rg.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/search-rg.ts) | 基于 ripgrep 语义执行工程代码与文档全文流式检索，受内存配额与智能截断保护 |
| `workspace/files.read` | `knowledge-workspace` | 查询视界（`sk`） / 维护视界（`skm`） | [files-read.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-read.ts) | 工作区文件安全分段读取，防范路径穿越与行数超限 |
| `workspace/files.list` | `knowledge-workspace` | 查询视界（`sk`） / 维护视界（`skm`） | [files-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-list.ts) | 工作区受控目录树层级与文件清单遍历 |
| `workspace/files.write` | `knowledge-workspace` | 维护视界（`skm`） | [files-write.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-write.ts) | 工作区受控文件全量安全写入与目录自动创建 |
| `workspace/files.edit` | `knowledge-workspace` | 维护视界（`skm`） | [files-edit.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/files-edit.ts) | 基于精确字符串匹配的工作区文件就地精准编辑 |
| `workspace/bash.exec` | `knowledge-workspace` | 维护视界（`skm`） | [bash-exec.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/bash-exec.ts) | 受限工作区内部的原生命令受控执行与状态捕获 |
| `workspace/links.verify` | `knowledge-workspace` | 维护视界（`skm`） | [links-verify.ts](file:///root/code/knowledge-dock/server/packages/knowledge-workspace/actions/links-verify.ts) | 零断链门禁校验，静态扫描文档相对路径、静态资源与标题锚点 |
| `knowledge/knowledge.collect` | `knowledge-inbox` | 查询视界（`sk`） / 维护视界（`skm`） | [knowledge-collect.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-collect.ts) | 收集排障经验与人工补充候选，结构化注入待审池 |
| `knowledge/knowledge.list` | `knowledge-inbox` | 维护视界（`skm`） | [knowledge-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-list.ts) | 遍历并过滤待审池中的候选文档元数据与状态 |
| `knowledge/knowledge.archive` | `knowledge-inbox` | 维护视界（`skm`） | [knowledge-archive.ts](file:///root/code/knowledge-dock/server/packages/knowledge-inbox/actions/knowledge-archive.ts) | 待审池候选决议归档，移至归档目录并记录处理结论 |
| `maintenance/maintenance.sync` | `knowledge-maintenance` | 维护视界（`skm`） | [maintenance-sync.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-sync.ts) | 双分支代码仓与单分支系统仓同步，冲突安全中止 |
| `maintenance/maintenance.list` | `knowledge-maintenance` | 维护视界（`skm`） | [maintenance-list.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-list.ts) | 扫描仓库自检查点以来的提交增量与受影响文件摘要 |
| `maintenance/maintenance.publish` | `knowledge-maintenance` | 维护视界（`skm`） | [maintenance-publish.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-publish.ts) | 知识分支文档提交与推送，强制校验业务代码防污染红线 |
| `maintenance/maintenance.complete` | `knowledge-maintenance` | 维护视界（`skm`） | [maintenance-complete.ts](file:///root/code/knowledge-dock/server/packages/knowledge-maintenance/actions/maintenance-complete.ts) | 推进检查点基线水位并持久化审计记录 |
| `orchestrator/orchestrator.pipeline` | `knowledge-orchestrator` | 客户端控制平面（纯本地执行） | [pipeline.ts](file:///root/code/knowledge-dock/client/packages/knowledge-orchestrator/actions/pipeline.ts) | 三阶段流水线调度、多仓增量巡检、模板渲染、超时轮询与审计报告生成 |

---

## 延伸阅读导航

- **全景架构设计指南**：了解系统核心组件、逻辑架构拓扑与运行时架构，参见 [architecture.md](file:///root/code/knowledge-dock/docs/architecture.md)；
- **核心概念与设计原则**：查阅四大核心设计原则、单端口虚拟视图、双分支隔离模型与检查点机制权威定义，参见 [concepts.md](file:///root/code/knowledge-dock/docs/concepts.md)；
- **端到端流程与生命周期**：掌握代码变更自维护、待审池流转闭环与三阶段流水线调度机制，参见 [workflow.md](file:///root/code/knowledge-dock/docs/workflow.md)；
- **智能体设计与角色矩阵**：了解贡献守门、特权维护、总控编排与只读排障助手的分工协同，参见 [agent-design.md](file:///root/code/knowledge-dock/docs/agent-design.md)；
- **部署与交付实战指南**：获取多仓库配置、双令牌安全基线、私有 Git 免密连接与 Docker 容器部署指引，参见 [deployment.md](file:///root/code/knowledge-dock/docs/deployment.md)；
- **知识运维与质量门禁**：获取检查点基线运维、待审池流转操作、零断链门禁自愈与日志审计手册，参见 [operations.md](file:///root/code/knowledge-dock/docs/operations.md)。
