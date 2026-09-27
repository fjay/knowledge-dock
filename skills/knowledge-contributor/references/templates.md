# 候选文档标准模板与范例手册

本手册提供生产排障（`troubleshooting`）与日常维护（`maintenance`）两套标准骨架模板，以及覆盖四大核心工作模式的工程实战范例。

---

## 生产排障标准骨架模板

生产排障模式（`contribution_type: troubleshooting`）专用于沉淀线上故障处置、异常堆栈分析、客诉排查及应急预案。

### 骨架定义

```markdown
---
schema_version: 1
title: <简明描述故障现象与核心根因>
domain: <业务领域标识，如 marketing / payment / order>
contribution_type: troubleshooting
knowledge_type: runbook
tags:
  - <关键标签1>
  - <错误特征码>
repos:
  - <相关代码仓目录名>
---

<!-- section:context -->
## 问题背景与现象
- 业务影响范围：<说明受影响的用户群体、业务时段与故障表现>
- 触发告警特征：<说明监控指标突增、告警规则触发情况>

<!-- section:evidence -->
## 证据链
- 核心异常日志：
  ```text
  <在此处粘贴经过脱敏处理的生产真实堆栈日志或关键特征行>
  ```
- 关键代码入口：`<工程相对路径:行号>，指出抛出异常或错误决策的代码符号`
- 配置快照依据：`<引用的配置项名、数据库配置快照或 Apollo/Nacos 键值>`

<!-- section:findings -->
## 已验证结论
- 故障直接诱因：<准确说明导致异常的输入条件或临界状态>
- 系统核心缺陷：<准确说明代码逻辑、并发控制或资源限制上的具体缺陷>
- 影响链路机制：<说明错误如何在上下游服务之间传播与放大>

<!-- section:candidates -->
## 建议沉淀的知识
- 拟合入目标知识库：`<建议合入的代码仓名称及类别路径，如 runbook/runbook-activity.md>`
- 应急恢复操作流程：
  - <步骤一：快速止血操作命令或配置回滚步骤>
  - <步骤二：数据对齐与状态修复补偿脚本>
- 根因防范建议：
  - <建议补充的参数校验规则或超时断路器配置>

<!-- section:unknowns -->
## 未确认事项
- <客观列出本次排障未完全摸清的细节，例如：缺少第三方支付渠道对端网关超时日志、偶发网络丢包率原因未定位>

<!-- section:maintainer -->
## Maintainer 处理记录
- （由维护智能体在核验归档时填写）
```

---

## 日常维护标准骨架模板

日常维护模式（`contribution_type: maintenance`）用于功能契约缺失提单、技术设计草案前置投递、业务主流程补充以及数据库字段与枚举语义勘误。

### 骨架定义

```markdown
---
schema_version: 1
title: <简明描述维护主题或契约补充事项>
domain: <业务领域标识，如 order / cert / settle>
contribution_type: maintenance
knowledge_type: <flow | rule | interface | data | module>
tags:
  - <关键标签1>
  - <业务概念名>
repos:
  - <相关代码仓目录名>
---

<!-- section:context -->
## 维护背景
- 触发背景说明：<说明为何需要补充该知识，如日常开发发现规范缺失、新功能上线前置设计、字段理解歧义等>
- 业务关键痛点：<说明由于知识缺失可能导致的新人上手困难或协作隐患>

<!-- section:content -->
## 建议内容
- 核心规范与契约：
  <清晰阐述补充的状态机流转规则、主时序链路、字段真实枚举或计算公式>

<!-- section:evidence -->
## 依据
- 源码事实依据：`<引用的代码文件路径与关键类/方法>`
- 设计资料依据：`<引用的技术设计文档、PRD、接口定义契约或数据库变更脚本>`

<!-- section:target -->
## 建议归属
- 建议归属仓库：`<目标代码仓路径或系统知识库>`
- 建议文件落位：`<具体类别目录与文件，如 flow/flow-refund-state.md 或 ddl 语义补丁>`

<!-- section:unknowns -->
## 未确认事项
- <客观列出尚未确定的逻辑边界，例如：部分历史旧单的数据迁移兼容规则未定>

<!-- section:maintainer -->
## Maintainer 处理记录
- （由维护智能体在核验归档时填写）
```

---

## 四大模式工程实战范例

### 模式一范例：开发者功能契约缺失提单

```markdown
---
schema_version: 1
title: 支付退款状态机与死信重试契约补充
domain: payment
contribution_type: maintenance
knowledge_type: rule
tags:
  - refund
  - state-machine
  - dead-letter
  - retry-policy
repos:
  - payment-service
---

<!-- section:context -->
## 维护背景
- 触发背景说明：在排查退款重试逻辑时，发现知识库现有 `rule/rule-payment.md` 仅定义了正向支付状态，未涵盖退款流程的状态转移矩阵与死信队列重试策略，导致团队对退款异常流转理解不一致。
- 业务关键痛点：新接入退款网关的同学不清楚退款挂起时的死信处理机制，容易错误地在客户端发起重复全额重试。

<!-- section:content -->
## 建议内容
- 退款主状态流转约束：
  - `REFUND_INIT`（初始化） -> `REFUND_PENDING`（渠道受理中） -> `REFUND_SUCCESS`（最终成功）；
  - `REFUND_PENDING` 遇渠道网络超时，禁止直接置为失败，必须流转至 `REFUND_SUSPENDED`（挂起对账中）；
  - 终态 `REFUND_FAILED` 仅在渠道显式返回不可逆错误码时触发。
- 退款死信队列阶梯重试规则：
  - 重试间隔遵循指数退避算法：初次重试 15 秒，二次重试 2 分钟，三次重试 15 分钟，四次重试 1 小时；
  - 超过四次仍未获得终态，消息路由至死信队列 `payment.refund.dlq`，并触发内部告警工单人工对账。

<!-- section:evidence -->
## 依据
- 源码事实依据：
  - 退款状态转移实现：`payment-service/src/main/java/com/service/refund/RefundStateMachine.java`
  - 队列重试拦截器：`payment-service/src/main/java/com/service/refund/mq/RefundRetryConsumer.java`
- 关联配置依据：`application.yml` 中的 `mq.refund.max-attempts=4` 与退避策略参数。

<!-- section:target -->
## 建议归属
- 建议归属仓库：`payment-service`
- 建议文件落位：补充至 `docs/knowledge/rule/rule-refund-lifecycle.md`，并在 `overview.md` 的核心规则矩阵中建立引用。

<!-- section:unknowns -->
## 未确认事项
- 历史分账退款在死信阶段是否支持自动部分冲退，尚未在老系统代码中确证，需要向资深对账研发确认。

<!-- section:maintainer -->
## Maintainer 处理记录
```

---

### 模式二范例：开发者技术设计与主流程草案投递

```markdown
---
schema_version: 1
title: 实名认证绑卡端到端跨仓主时序草案
domain: certification
contribution_type: maintenance
knowledge_type: flow
tags:
  - real-name
  - bind-card
  - cross-repo
  - three-party-auth
repos:
  - user-center
  - payment-gateway
---

<!-- section:context -->
## 维护背景
- 触发背景说明：配合合规审计要求，实名认证与银行卡绑定流程进行了架构重构，解耦了用户中心与支付网关的直接同步依赖，改为三要素预校验加异步银行验真模型。
- 业务关键痛点：当前跨仓端到端时序尚未在系统知识库体现，涉及新开辟业务域的架构演化。

<!-- section:content -->
## 建议内容
- 端到端跨仓调用主时序：
  - 移动端调用 `user-center` 的 `POST /api/v2/cert/bind` 接口发起绑卡，包含用户身份证号、姓名、银行卡号与银行预留手机号；
  - `user-center` 执行基本格式前置校验，生成认证流水单（状态为 `AUTH_INIT`），并通过 RPC 同步调用 `payment-gateway` 的三要素验证；
  - `payment-gateway` 路由至指定银行清算网关，获取三要素校验结果与签约协议号；
  - 若三要素通过，`payment-gateway` 返回协议号并下发银行短信验证码，`user-center` 推进流水单至 `VERIFY_CODE_SENT`；
  - 用户提交验证码后，`user-center` 驱动终态落库并异步广播 `cert.bind.completed` 事件，下游信用评估与风控中心消费该事件建立授信档案。

<!-- section:evidence -->
## 依据
- 架构设计方案文档：`@docs/designs/2026-v2-bind-card-architecture.md`
- 关键接口定义：
  - `user-center/src/api/CertController.ts`
  - `payment-gateway/src/rpc/BankCardAuthServiceImpl.java`

<!-- section:target -->
## 建议归属
- 建议归属仓库：系统知识仓 `system-knowledge`
- 建议文件落位：新增业务域 `certification/flow/flow-bind-card.md`，并同步更新系统根目录 `index.md` 业务领域与代码仓映射表。

<!-- section:unknowns -->
## 未确认事项
- 港澳台同胞居住证与护照认证通道目前尚未走银行网关，走人工审核通道，人工审批流未在本次草案中体现。

<!-- section:maintainer -->
## Maintainer 处理记录
```

---

### 模式三范例：数据库字段与枚举语义勘误

```markdown
---
schema_version: 1
title: 订单主表结算状态字段注释与代码枚举勘误
domain: order
contribution_type: maintenance
knowledge_type: data
tags:
  - order-master
  - settle-status
  - enum-patch
  - ddl-fix
repos:
  - order-service
---

<!-- section:context -->
## 维护背景
- 触发背景说明：运营人员与数据开发在编写结算对账报表时，发现 `order_master` 表的 `settle_status` 字段实际存储值包含 3 和 4，但现有 DDL 注释仅标注了 0（未结算）、1（已结算）、2（结算失败），导致对账统计失真。
- 业务关键痛点：生产数据库字段注释长期未同步，与业务代码实际枚举存在脱节。

<!-- section:content -->
## 建议内容
- 数据库字段语义补丁定义：
  - 库名：`order_prod`
  - 表名：`order_master`
  - 字段名：`settle_status`
  - 正确语义完整对照表：
    - `0`：未发起结算
    - `1`：结算处理中（资金托管冻结）
    - `2`：结算成功（终态）
    - `3`：挂起对账中（因节假日清算行对账延迟挂起）
    - `4`：结算退回作废（因商家账户注销冲正）
- 建议更新 DDL 补丁行：
  `| order_master | settle_status | 0-未结算, 1-结算中, 2-已结算, 3-挂起对账, 4-退回作废 | 依据 SettleStatusEnum.java 代码事实 |`

<!-- section:evidence -->
## 依据
- 源码枚举类事实：`order-service/src/main/java/com/order/enums/SettleStatusEnum.java`
- 结算补偿批处理任务代码：`order-service/src/main/java/com/order/job/SettlePendingJob.java`

<!-- section:target -->
## 建议归属
- 建议归属仓库：系统知识仓 `system-knowledge`
- 建议文件落位：合入系统层 DDL 映射文件 `ddl/data-ddl-order.md` 中的 `## 字段语义补丁` 节。

<!-- section:unknowns -->
## 未确认事项
- 状态 4 的冲正操作是否会自动冲减增值税发票，尚未在发票模块找到联动代码。

<!-- section:maintainer -->
## Maintainer 处理记录
```

---

### 模式四范例：生产排障与客诉根因手记沉淀

```markdown
---
schema_version: 1
title: 营销活动预算超限导致资格过滤故障分析
domain: marketing
contribution_type: troubleshooting
knowledge_type: runbook
tags:
  - marketing
  - budget-limit
  - activity-filter
  - err-act-4001
repos:
  - marketing-service
---

<!-- section:context -->
## 问题背景与现象
- 业务影响范围：大促期间 20:00 至 20:25，华东大区约 1200 名高价值会员在支付前无法享受立减优惠，引发客户集中投诉。
- 触发告警特征：网关错误指标突增，营销网关上报 `ACT_BUDGET_EXCEEDED` 错误码比率达到 18%。

<!-- section:evidence -->
## 证据链
- 核心异常日志：
  ```text
  2026-09-27 20:05:12.304 [pool-3-thread-42] WARN  c.m.service.checker.BudgetChecker - [TraceId: 7b8192a0e41f48]
  Activity qualification check failed. ActivityId: ACT-20260927-01, RuleId: RULE-BUDGET-99.
  Reason: Current accumulated cost 5000000 reached total budget limit 5000000. ErrorCode: ERR_ACT_4001.
  ```
- 关键代码入口：`marketing-service/src/main/java/com/marketing/eval/checker/BudgetChecker.java:88`
- 配置快照依据：Redis 实时预算累计键 `budget:act:ACT-20260927-01:cost` 数值达到上限阈值。

<!-- section:findings -->
## 已验证结论
- 故障直接诱因：大促前运营追加了 200 万元活动专款，并在中台更新了预算单，但营销服务仅拉取了本地初始配置，未监听配置中心预算变更通知。
- 系统核心缺陷：`BudgetChecker` 内部持有基于内存的 `GuavaCache`，其过期时间配置为 24 小时，且未实现配置中心的主动失效广播机制，导致内存数据与中台真实预算脱节。
- 影响链路机制：营销服务判定预算超限后，在候选活动列表中直接将该活动标记为不可用，前台收银台降级显示为原价。

<!-- section:candidates -->
## 建议沉淀的知识
- 拟合入目标知识库：`marketing-service/docs/knowledge/runbook/runbook-activity.md`
- 应急恢复操作流程：
  - 步骤一：通过运营控制台调用刷新接口强制驱逐节点本地缓存：
    `curl -X POST http://marketing-service.internal/actuator/cache/evict -d 'cacheName=activityBudgetCache'`
  - 步骤二：核实节点最新预算阈值是否生效：
    `curl -s http://marketing-service.internal/actuator/cache/get?key=ACT-20260927-01`
- 根因防范建议：
  - 推动架构改造，将本地长周期缓存替换为带有发布订阅机制的分布式缓存协同方案。

<!-- section:unknowns -->
## 未确认事项
- 活动超限期间是否存在小部分订单通过并发竞争绕过了预算校验，正在由财务进行对账核实。

<!-- section:maintainer -->
## Maintainer 处理记录
```
