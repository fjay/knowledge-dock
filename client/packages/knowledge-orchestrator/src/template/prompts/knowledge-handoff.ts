/** 单仓维护结果通过检查点回传，供后续系统层定向聚合。 */
export function buildKnowledgeHandoffInstructions(): string[] {
  return [
    `## 本次知识变更交接`,
    ``,
    `- 系统知识库代理会在单仓任务结束后消费本次结果。发布前记录本任务实际新建、修改或删除的知识文档路径与主题说明，发布后核对本次提交，不用历史记录或发布后为空的工作区 diff 代替本次变更。`,
    `- 调用 maintenance.complete 时，summary 概括本次涉及的流程、契约、规则与跨仓影响；同时提供 knowledgeChanges 数组，每项包含 path（安全的仓库相对文档路径）与 summary（该文档的主题及新增、修改或删除说明），不复制整篇正文或真实凭据。`,
    `- 非空清单可用连续扁平参数：knowledgeChanges.0.path="docs/knowledge/flow/flow-order.md" knowledgeChanges.0.summary="补齐订单失败恢复与下游交接"；多篇从索引 0 连续递增，复杂内容使用 --input-file。这些参数与最终 complete 的 path、commit、actionTaken、summary 一起提交。`,
    `- 本次确无文档改动时显式传 knowledgeChanges:=[]，并在 summary 中说明实际核验范围；清单缺省表示未回传，不等于没有改动。不要在单仓任务中直接修改系统仓，后续由系统知识库代理统一聚合。`,
    ``,
  ];
}
