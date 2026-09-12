import { z } from "zod";

export const providerModeSchema = z.enum(["live", "replay"]);
export type ProviderMode = z.infer<typeof providerModeSchema>;
export const provenanceSchema = z.object({
  provider: z.enum(["zhihu", "replay"]), mode: providerModeSchema,
  fetchedAt: z.string().datetime(), requestId: z.string().optional(), snapshotId: z.string().optional(),
  sourceNature: z.enum(["remote", "official_example", "synthetic"]).optional(),
});
export type Provenance = z.infer<typeof provenanceSchema>;
export const sourceItemSchema = z.object({
  sourceId: z.string().min(1), type: z.enum(["search", "hot", "circle_post", "circle_comment"]),
  title: z.string().optional(), summary: z.string(), url: z.string().url().optional(),
  author: z.object({ displayName: z.string(), avatarUrl: z.string().url().optional() }).optional(),
  publishedAt: z.string().datetime().optional(), provenance: provenanceSchema,
});
export type SourceItem = z.infer<typeof sourceItemSchema>;
export const sourceSnapshotSchema = z.object({
  items: z.array(sourceItemSchema), provenance: provenanceSchema,
  nextCursor: z.string().optional(), emptyReason: z.string().optional(),
});
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export const searchInputSchema = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(10).optional() });
export type SearchInput = z.infer<typeof searchInputSchema>;
export const circleInputSchema = z.object({ circleId: z.string().min(1), pinId: z.string().min(1).optional(), cursor: z.string().optional() });
export type CircleInput = z.infer<typeof circleInputSchema>;
export const publishInputSchema = z.object({
  circleId: z.string().min(1), text: z.string().trim().min(1).max(10000),
  idempotencyKey: z.string().min(1).max(200), approvedPayloadHash: z.string().min(1),
});
export type PublishInput = z.infer<typeof publishInputSchema>;
export const publishReceiptSchema = z.object({
  remoteId: z.string().min(1), url: z.string().url().optional(), sentAt: z.string().datetime(),
  mode: providerModeSchema, provenance: provenanceSchema,
});
export type PublishReceipt = z.infer<typeof publishReceiptSchema>;
export interface ZhihuProvider {
  readonly mode: ProviderMode;
  searchTopics(input: SearchInput): Promise<SourceSnapshot>;
  hotList(input?: { limit?: number }): Promise<SourceSnapshot>;
  listCircleDiscussion(input: CircleInput): Promise<SourceSnapshot>;
  publishCircleQuestion(input: PublishInput): Promise<PublishReceipt>;
}

export const modelRunSchema = z.object({
  model: z.string().min(1), mode: providerModeSchema, promptVersion: z.string(), rulesVersion: z.string(),
  inputEvidenceIds: z.array(z.string()), createdAt: z.string().datetime(),
});
export type ModelRun = z.infer<typeof modelRunSchema>;
const conditionSchema = z.object({ id: z.string().min(1), label: z.string().min(1) });
const evidenceSchema = z.object({ id: z.string().min(1), summary: z.string().max(12000) });
const reasonSchema = z.string().trim().min(4).max(1500);
export const analysisInputSchema = z.object({
  topic: z.object({ id: z.string().min(1), title: z.string().min(1) }),
  experience: z.object({ id: z.string().min(1), publicText: z.string().trim().min(1).max(12000) }),
  conditions: z.array(conditionSchema).max(100), evidence: z.array(evidenceSchema).max(100),
});
export type AnalysisInput = z.infer<typeof analysisInputSchema>;
export const analysisDraftSchema = z.object({
  status: z.enum(["ready", "needs_review"]), extractedConditions: z.array(z.string().min(1)).max(15),
  matches: z.array(z.object({
    conditionIds: z.array(z.string()).min(1), evidenceIds: z.array(z.string()),
    relation: z.enum(["support", "conflict", "extends", "unknown"]),
    reasons: z.tuple([reasonSchema, reasonSchema]).rest(reasonSchema), confidence: z.number().min(0).max(1),
  })).max(30), caveats: z.array(z.string()).max(15),
});
export const analysisResultSchema = analysisDraftSchema.extend({ modelRun: modelRunSchema });
export type AnalysisResult = z.infer<typeof analysisResultSchema>;
export const probeInputSchema = z.object({
  topicId: z.string().min(1), baseVersionId: z.string().min(1),
  unknowns: z.array(conditionSchema).max(100), evidence: z.array(evidenceSchema).max(100),
});
export type ProbeInput = z.infer<typeof probeInputSchema>;
export const probeDraftSchema = z.object({
  question: z.string().min(4).max(2000), targetUnknownId: z.string().min(1),
  rationale: reasonSchema, informationGainExplanation: reasonSchema,
  evidenceIds: z.array(z.string()), status: z.enum(["draft", "needs_review"]),
});
export const probeResultSchema = probeDraftSchema.extend({ modelRun: modelRunSchema });
export type ProbeResult = z.infer<typeof probeResultSchema>;
export const revisionInputSchema = z.object({
  topicId: z.string().min(1), baseVersionId: z.string().min(1), currentText: z.string().min(1).max(30000),
  currentConditions: z.array(conditionSchema).max(100), newEvidence: z.array(evidenceSchema).max(100),
});
export type RevisionInput = z.infer<typeof revisionInputSchema>;
export const revisionDraftSchema = z.object({
  proposedText: z.string().min(1).max(35000),
  proposedConditions: z.array(z.object({ label: z.string().min(1), evidenceIds: z.array(z.string()) })).max(100),
  diff: z.array(z.object({
    kind: z.enum(["added", "removed", "changed"]), before: z.string().optional(), after: z.string().optional(),
    evidenceIds: z.array(z.string()).min(1), reason: reasonSchema,
  })).max(50), explanation: reasonSchema, confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string()), status: z.enum(["proposed", "needs_review"]),
});
export const revisionResultSchema = revisionDraftSchema.extend({ modelRun: modelRunSchema });
export type RevisionResult = z.infer<typeof revisionResultSchema>;
export interface LLMProvider {
  readonly mode: ProviderMode;
  analyzeEvidence(input: AnalysisInput): Promise<AnalysisResult>;
  proposeProbe(input: ProbeInput): Promise<ProbeResult>;
  proposeRevision(input: RevisionInput): Promise<RevisionResult>;
}

export type ProviderErrorKind = "unconfigured" | "unsupported" | "unauthorized" | "rate_limited" | "timeout" | "invalid_response" | "unavailable" | "unknown_delivery";
const modelDiagnosticOperation = z.enum(["analysis", "probe", "revision"]);
const modelDiagnosticStage = z.enum(["envelope_json", "envelope_schema", "envelope_error", "finish_reason", "content_size", "content_json", "output_schema", "semantic_validation"]);
const modelDiagnosticFinishReason = z.enum(["stop", "length", "error", "content_filter", "tool_calls", "function_call", "unspecified", "unknown"]);
const modelDiagnosticIssueCode = z.enum(["invalid_type", "too_big", "too_small", "invalid_format", "not_multiple_of", "unrecognized_keys", "invalid_union", "invalid_key", "invalid_element", "invalid_value", "custom", "unknown"]);
const modelDiagnosticFields = new Set([
  "model", "choices", "message", "content", "finish_reason", "status", "extractedConditions", "matches",
  "conditionIds", "evidenceIds", "relation", "reasons", "confidence", "caveats", "question", "targetUnknownId",
  "rationale", "informationGainExplanation", "proposedText", "proposedConditions", "label", "diff", "kind",
  "before", "after", "reason", "explanation",
  "[index]", "[redacted]",
]);
export type ModelResponseDiagnostic = {
  operation: z.infer<typeof modelDiagnosticOperation>;
  stage: z.infer<typeof modelDiagnosticStage>;
  finishReason?: z.infer<typeof modelDiagnosticFinishReason>;
  issues?: { code: z.infer<typeof modelDiagnosticIssueCode>; path: (string | number)[] }[];
};

// Diagnostic inputs are untrusted too: never copy issue messages, unknown object keys,
// received values, upstream finish strings, or arbitrary additional properties.
export function sanitizeModelDiagnostic(value: unknown): ModelResponseDiagnostic | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const operation = modelDiagnosticOperation.safeParse(candidate.operation);
  const stage = modelDiagnosticStage.safeParse(candidate.stage);
  if (!operation.success || !stage.success) return undefined;
  const diagnostic: ModelResponseDiagnostic = { operation: operation.data, stage: stage.data };
  if (candidate.finishReason !== undefined) {
    const finishReason = modelDiagnosticFinishReason.safeParse(candidate.finishReason);
    diagnostic.finishReason = candidate.finishReason === null ? "unspecified" : finishReason.success ? finishReason.data : "unknown";
  }
  if (Array.isArray(candidate.issues)) diagnostic.issues = candidate.issues.slice(0, 8).map((value: unknown) => {
    const issue = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const code = modelDiagnosticIssueCode.safeParse(issue.code);
    return {
      code: code.success ? code.data : "unknown",
      path: Array.isArray(issue.path) ? issue.path.slice(0, 8).map((segment: unknown) => {
        if (typeof segment === "number") return Number.isInteger(segment) && segment >= 0 && segment <= 9999 ? segment : "[index]";
        return typeof segment === "string" && modelDiagnosticFields.has(segment) ? segment : "[redacted]";
      }) : [],
    };
  });
  return diagnostic;
}

export class ProviderError extends Error {
  public readonly diagnostic?: ModelResponseDiagnostic;
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
    public readonly requestId?: string,
    diagnostic?: ModelResponseDiagnostic,
  ) { super(message); this.name = "ProviderError"; this.diagnostic = sanitizeModelDiagnostic(diagnostic); }
}

export function validateInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProviderError("invalid_response", "输入数据不满足分析要求。");
  return parsed.data;
}
export function assertServer(): void {
  if (typeof window !== "undefined") throw new Error("Providers are server-only.");
}
export function validateReferences(actual: string[], allowed: string[], name = "证据"): void {
  const set = new Set(allowed);
  if (actual.some((id) => !set.has(id))) throw new ProviderError("invalid_response", `分析引用了输入中不存在的${name}。`);
}
