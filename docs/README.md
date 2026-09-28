# 文档导航

第一次接触项目，先读[根 README](../README.md)并完成首次运行。其余文档按当前任务选择，无需按目录顺序通读。

| 你要做什么 | 阅读入口 |
|---|---|
| 评估系统是否适合现有研发流程 | [架构与边界](architecture.md) |
| 理解代码变更、智能体和待审池如何协作 | [知识维护流程](workflow.md) |
| 编写正式知识或提交排障经验 | [知识格式](knowledge-model.md) |
| 安装服务并接入代码仓 | [部署指南](deployment.md) |
| 在本地执行批量维护流水线 | [编排指南](orchestration.md) |
| 查看检查点、处理故障和执行发布检查 | [运维手册](operations.md) |
| 看一次完整的业务变更演示 | [支付超时示例](examples/payment-flow.md) |

动作的完整入参和返回结构以各包的 `actiondock.json` 为准；子包 README 提供常用调用方式：

- [工作区动作](../server/packages/knowledge-workspace/README.md)
- [待审池动作](../server/packages/knowledge-inbox/README.md)
- [仓库维护动作](../server/packages/knowledge-maintenance/README.md)
- [客户端编排动作](../client/packages/knowledge-orchestrator/README.md)

正式知识与本仓的产品文档不是同一目录。被纳管业务仓的知识放在其 `docs/knowledge/` 中；当前目录 `docs/` 说明 knowledge-dock 自身的设计与使用。
