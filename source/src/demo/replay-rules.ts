// Teaching rules copied from the server replay provider. No network or model API calls.
import {
 analysisInputSchema, analysisResultSchema, probeInputSchema, probeResultSchema,
 revisionInputSchema, revisionResultSchema, validateInput, validateReferences, ProviderError,
 type AnalysisInput, type AnalysisResult, type ProbeInput, type ProbeResult,
 type RevisionInput, type RevisionResult, type ModelRun, type LLMProvider,
} from "@/providers/contracts";
const PROMPT_VERSION = "kanshan-structured-v1";
const RULES_VERSION = "evidence-review-v1";
function checkAnalysis(result: AnalysisResult, input: AnalysisInput): AnalysisResult {
  for (const match of result.matches) {
    validateReferences(match.conditionIds, input.conditions.map((c) => c.id), "条件");
    validateReferences(match.evidenceIds, input.evidence.map((e) => e.id));
    if (!match.evidenceIds.length || match.confidence < 0.5 || match.relation === "unknown") result.status = "needs_review";
  }
  if (!result.matches.length || !input.evidence.length) result.status = "needs_review";
  return analysisResultSchema.parse(result);
}
function checkProbe(result: ProbeResult, input: ProbeInput): ProbeResult {
  validateReferences([result.targetUnknownId], input.unknowns.map((u) => u.id), "未知点");
  validateReferences(result.evidenceIds, input.evidence.map((e) => e.id));
  if (!result.evidenceIds.length) result.status = "needs_review";
  return probeResultSchema.parse(result);
}
function checkRevision(result: RevisionResult, input: RevisionInput): RevisionResult {
  const allowed = input.newEvidence.map((e) => e.id);
  validateReferences(result.evidenceIds, allowed);
  for (const condition of result.proposedConditions) validateReferences(condition.evidenceIds, allowed);
  for (const diff of result.diff) {
    validateReferences(diff.evidenceIds, allowed);
    if ((diff.kind === "removed" || diff.kind === "changed") && (!diff.before || !input.currentText.includes(diff.before))) {
      throw new ProviderError("invalid_response", "修订引用的原文与当前版本不一致。");
    }
    if ((diff.kind === "added" || diff.kind === "changed") && (!diff.after || !result.proposedText.includes(diff.after))) {
      throw new ProviderError("invalid_response", "修订差异与建议正文不一致。");
    }
    if (diff.after && /所有人都|任何人都|必然成功|一定成功|百分之百|100%成功/.test(diff.after.replace(/不代表所有人|不能保证|不意味着/g, ""))) {
      throw new ProviderError("invalid_response", "证据不足以支持普遍保证，请保留适用条件。");
    }
  }
  if (!allowed.length || !result.diff.length || !result.evidenceIds.length || result.confidence < 0.5) result.status = "needs_review";
  return revisionResultSchema.parse(result);
}

const facets = [
  { id: "prototype", label: "完成展示原型", words: ["原型", "demo", "展示", "可点击", "界面", "页面"] },
  { id: "production", label: "持续服务真实用户", words: ["上线", "真实用户", "长期", "持续", "服务", "维护", "三个月"] },
  { id: "security", label: "权限、安全与数据保护", words: ["安全", "权限", "漏洞", "备份", "隐私", "数据丢失"] },
  { id: "cost", label: "模型和运行成本", words: ["成本", "费用", "预算", "收费", "花费", "账单"] },
  { id: "understanding", label: "理解和独立验证代码", words: ["理解", "学习", "基础", "编程", "调试", "测试", "验证", "排查"] },
];
function foundFacets(text: string) { const lower = text.toLowerCase(); return facets.filter((facet) => facet.words.some((word) => lower.includes(word))); }
function overlap(left: string, right: string): number {
  const a = new Set(foundFacets(left).map((f) => f.id));
  return foundFacets(right).filter((f) => a.has(f.id)).length;
}
function excerpt(text: string, limit = 90): string { return text.replace(/\s+/g, " ").trim().slice(0, limit); }
export class BrowserReplayRules implements LLMProvider {
  readonly mode = "replay" as const;
  constructor(private readonly options: { now?: () => Date } = {}) {}
  private modelRun(ids: string[]): ModelRun {
    return { model: "kanshan-local-rules-v1", mode: this.mode, promptVersion: PROMPT_VERSION, rulesVersion: RULES_VERSION, inputEvidenceIds: ids, createdAt: (this.options.now?.() ?? new Date()).toISOString() };
  }
  async analyzeEvidence(input: AnalysisInput): Promise<AnalysisResult> {
    const valid = validateInput(analysisInputSchema, input); const text = valid.experience.publicText;
    const related = valid.conditions.filter((condition) => overlap(condition.label, text) > 0 || text.includes(condition.label));
    const extracted = foundFacets(text).map((facet) => facet.label);
    const evidence = valid.evidence.filter((row) => overlap(row.summary, text) > 0);
    const negative = /失败|做不到|无法|不能|丢失|漏洞|崩溃|不稳定/.test(text);
    const limiting = /但是|不过|仅|只是|只用于|还需要|需要|前提|同时|之后/.test(text);
    const relation = negative ? "conflict" : limiting ? "extends" : "support";
    const matches: AnalysisResult["matches"] = related.map((condition) => ({
      conditionIds: [condition.id], evidenceIds: evidence.slice(0, 3).map((e) => e.id), relation,
      reasons: [
        `这条经历写到“${excerpt(text, 72)}”，直接涉及“${condition.label}”。`,
        evidence.length ? `已有材料中，“${excerpt(evidence[0].summary, 58)}”提供了可比较的条件；仍需核实两者的目标和使用阶段是否相同。` : `目前没有可对照的已有证据，先记录“${condition.label}”这一线索，不把单次经历当成普遍结论。`,
      ], confidence: evidence.length ? 0.68 : 0.35,
    }));
    return checkAnalysis({
      status: matches.length && evidence.length ? "ready" : "needs_review",
      extractedConditions: extracted.length ? extracted : ["需要明确经历的目标、采取的行动和实际结果"], matches,
      caveats: ["这是本地演示规则的条件匹配，尚未调用通用模型。", "单次经历只能补充适用条件，公共答案仍需人工审核。"],
      modelRun: this.modelRun(valid.evidence.map((e) => e.id)),
    }, valid);
  }
  async proposeProbe(input: ProbeInput): Promise<ProbeResult> {
    const valid = validateInput(probeInputSchema, input);
    if (!valid.unknowns.length) throw new ProviderError("unsupported", "当前没有待追问的未知点，请先补充条件。");
    const scored = valid.unknowns.map((unknown, index) => ({ unknown, index, score: valid.evidence.reduce((sum, e) => sum + overlap(unknown.label, e.summary), 0) })).sort((a, b) => b.score - a.score || a.index - b.index);
    const target = scored[0].unknown;
    const relevant = valid.evidence.filter((e) => overlap(target.label, e.summary) > 0);
    const ids = relevant.slice(0, 3).map((e) => e.id);
    return checkProbe({
      question: `想请有亲身经历的朋友补充：关于“${target.label}”，你的具体目标、采用的方法和后续结果分别是什么？哪些部分能独立完成，哪些需要额外帮助？`,
      targetUnknownId: target.id,
      rationale: `“${target.label}”与现有材料的条件分歧直接相关。问清具体行动和后续结果，能帮助我们辨别表面相似的经历。`,
      informationGainExplanation: "如果回复说明了目标、条件和结果，我们可以保留不同情境下的答案；这是启发式选择，不是测得的信息增益数值。",
      evidenceIds: ids, status: ids.length ? "draft" : "needs_review", modelRun: this.modelRun(valid.evidence.map((e) => e.id)),
    }, valid);
  }
  async proposeRevision(input: RevisionInput): Promise<RevisionResult> {
    const valid = validateInput(revisionInputSchema, input);
    const meaningful = valid.newEvidence.filter((e) => e.summary.trim().length >= 8);
    const sourceIds = meaningful.map((e) => e.id);
    const categories = [...new Set(meaningful.flatMap((e) => foundFacets(e.summary).map((f) => f.label)))];
    const addition = meaningful.length
      ? `新增经历提示：${meaningful.slice(0, 3).map((e) => `“${excerpt(e.summary, 180)}”`).join("；")}。${categories.length ? `这些经历涉及${categories.join("、")}，需要分别核对适用条件。` : "需要进一步追问目标、行动与结果。"}这仍是有限案例，不代表所有人都会得到相同结果。`
      : "";
    const proposedText = addition ? `${valid.currentText}\n\n${addition}` : valid.currentText;
    return checkRevision({
      proposedText,
      proposedConditions: [
        ...valid.currentConditions.map((c) => ({ label: c.label, evidenceIds: [] as string[] })),
        ...categories.filter((label) => !valid.currentConditions.some((c) => c.label === label)).map((label) => ({ label, evidenceIds: meaningful.filter((e) => overlap(label, e.summary) > 0).map((e) => e.id) })),
      ],
      diff: addition ? [{ kind: "added", after: addition, evidenceIds: sourceIds, reason: "新增案例补充了适用情境，保留原有答案和分歧，由维护者判断是否接受。" }] : [],
      explanation: meaningful.length ? "看山把新经历保留为有来源的补充，没有用少量案例覆盖原结论。这是本地规则生成的待审核修订。" : "目前没有足够具体的新证据，保留原答案，等待进一步补充。",
      confidence: meaningful.length ? 0.62 : 0.2, evidenceIds: sourceIds,
      status: meaningful.length && categories.length ? "proposed" : "needs_review", modelRun: this.modelRun(valid.newEvidence.map((e) => e.id)),
    }, valid);
  }
}
