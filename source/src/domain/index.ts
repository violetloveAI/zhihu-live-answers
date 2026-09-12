import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export type ProviderMode = "live" | "replay";
export type Role = "contributor" | "maintainer";
export type DisplayMode = "nickname" | "anonymous" | "pseudonym";
export type ContributionKind = "experience" | "comment" | "evidence";
export type ConditionKind = "support" | "conflict" | "unknown" | "context";
export interface ModelRun { model: string; mode: ProviderMode; promptVersion: string; rulesVersion: string; inputEvidenceIds: string[]; createdAt: string }
export interface Provenance { provider: "zhihu" | "replay" | "experience"; mode: ProviderMode; fetchedAt: string; requestId?: string; snapshotId?: string; sourceNature?: "remote" | "official_example" | "synthetic" | "user_provided" }
export interface ConditionSnapshot { id?: string; label: string; description?: string; kind?: ConditionKind; evidenceIds: string[]; status?: string }
export interface VersionDiff { kind: "added" | "removed" | "changed"; conditionId?: string; before?: string; after?: string; evidenceIds: string[]; reason: string }
export interface Actor { id: string; workspaceId: string; role: Role; mode: ProviderMode; displayName: string; avatarUrl?: string | null }
export const PREVIEW_WORKSPACE = "preview";
export const PUBLIC_WORKSPACE = "public";

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 400, public retryable = false) { super(message); this.name = "DomainError"; }
}
export function requireRole(actor: Actor | null, role: Role = "contributor"): asserts actor is Actor {
  if (!actor) throw new DomainError("unauthenticated", "请先登录，再记录这条经验。", 401);
  if (role === "maintainer" && actor.role !== role) throw new DomainError("forbidden", "只有维护者可以审核这个操作。", 403);
  if (actor.workspaceId === PREVIEW_WORKSPACE || (actor.mode === "replay" && actor.workspaceId === PUBLIC_WORKSPACE)) throw new DomainError("workspace_forbidden", "当前身份不能修改这个工作区。", 403);
}
export function workspaceFor(actor: Actor | null): string { return actor?.workspaceId ?? PUBLIC_WORKSPACE; }

const displayMode = z.enum(["nickname", "anonymous", "pseudonym"]);
const identityShape = { displayMode, pseudonym: z.string().trim().min(2).max(24).optional() };
const identityRefinement = (v: { displayMode: string; pseudonym?: string }) => v.displayMode !== "pseudonym" || Boolean(v.pseudonym);
export function isSafePublicUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && !!url.hostname && !url.username && !url.password && !/[\s\\\u0000-\u001f\u007f]/.test(value); } catch { return false; }
}
const contributionShape = { text: z.string().trim().min(5).max(6000), contributionKind: z.enum(["experience", "comment", "evidence"]).optional(), replyToProbeId: z.string().trim().min(1).max(160).optional(), sourceUrl: z.string().trim().max(2048).refine(isSafePublicUrl, "请填写不含账号密码的 HTTPS 来源链接。").optional(), ...identityShape };
function validateContribution(input: {text:string;contributionKind?:ContributionKind;sourceUrl?:string}, context:z.RefinementCtx) {
  const kind=input.contributionKind??"experience",min=kind==="experience"?20:kind==="evidence"?10:5;
  if(input.text.length<min)context.addIssue({code:"custom",path:["text"],message:`${kind==="experience"?"经历":kind==="evidence"?"来源说明":"评论"}至少需要 ${min} 字。`});
  if(kind==="evidence"&&!input.sourceUrl)context.addIssue({code:"custom",path:["sourceUrl"],message:"补充证据需要提供来源链接。"});
  if(kind!=="evidence"&&input.sourceUrl)context.addIssue({code:"custom",path:["sourceUrl"],message:"附来源链接时，请选择补充证据。"});
}
export const experiencePreviewSchema = z.object(contributionShape).strict().refine(identityRefinement, { path: ["pseudonym"], message: "请填写 2–24 字的化名。" }).superRefine(validateContribution);
export const experienceSubmitSchema = z.object({ ...contributionShape, publicText: z.string().min(1).max(6000), previewHash: z.string().min(32).max(160), confirmed: z.literal(true) }).strict().refine(identityRefinement, { path: ["pseudonym"], message: "请填写化名。" }).superRefine(validateContribution);
export const confirmationSchema = z.object({ confirmed: z.literal(true) }).strict();
export const demoLoginSchema = z.object({ role: z.enum(["contributor", "maintainer"]) }).strict();
export const sourceRefreshSchema = z.object({ source: z.enum(["search", "circle", "all"]), query: z.string().trim().min(1).max(200).optional() }).strict();
export const createTopicSchema = z.object({ title: z.string().trim().min(5).max(200), template: z.enum(["learning", "social"]), sourceEvidenceIds: z.array(z.string()).max(30), circleId: z.string().max(160).optional() }).strict();
const probeShape = { question: z.string().trim().min(10).max(3000).optional(), target: z.enum(["in_app", "zhihu_circle"]), circleId: z.string().max(160).optional(), ...identityShape };
export const probePreviewSchema = z.object(probeShape).strict().refine(identityRefinement, { path: ["pseudonym"], message: "请填写化名。" });
export const probeApproveSchema = z.object({ ...probeShape, confirmed: z.literal(true), previewHash: z.string().min(32).max(160) }).strict().refine(identityRefinement, { path: ["pseudonym"], message: "请填写化名。" });
export const probeDecisionSchema = z.object({ decision: z.enum(["reject", "defer"]), reason: z.string().trim().max(1000).optional() }).strict();
export const revisionCreateSchema = z.object({ evidenceIds: z.array(z.string().min(1)).min(1).max(30) }).strict();
export const revisionDecisionSchema = z.object({ decision: z.enum(["accept", "reject", "defer"]), baseVersionId: z.string().min(1), confirmed: z.literal(true).optional(), reason: z.string().trim().max(1000).optional() }).strict().refine(v => v.decision !== "accept" || v.confirmed === true, { path: ["confirmed"], message: "接受修订需要确认。" });
export const reportSchema = z.object({ entityType: z.enum(["evidence", "experience", "probe", "revision", "version"]), entityId: z.string().min(1), reason: z.string().trim().min(5).max(1000) }).strict();
export const reportDecisionSchema = z.object({ decision: z.enum(["dismiss", "hide"]), reason: z.string().trim().min(5).max(1000) }).strict();
export const replayReplySchema = z.object({ scenarioId: z.string().min(1).max(120) }).strict();
export const emptySchema = z.object({}).strict();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function contentHash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function equalHash(a: string, b: string): boolean { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x,y); }
export interface Redaction { type: "phone" | "email" | "identity_number"; start: number; end: number; replacement: string }
/** A deterministic preview, never a promise to detect every possible identifier. */
export function redactPII(text: string): { publicText: string; redactions: Redaction[] } {
  const candidates: Redaction[] = [];
  const rules: [Redaction["type"], RegExp, string][] = [
    ["identity_number", /(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g, "[身份证号已隐藏]"],
    ["email", /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/gi, "[邮箱已隐藏]"],
    ["phone", /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d(?:[-\s]?\d){8}(?!\d)/g, "[手机号已隐藏]"],
  ];
  for (const [type, pattern, replacement] of rules) for (const m of text.matchAll(pattern)) { const start = m.index; const end = start + m[0].length; if (!candidates.some(x => start < x.end && end > x.start)) candidates.push({ type,start,end,replacement }); }
  candidates.sort((a,b) => a.start-b.start);
  let publicText = "", cursor = 0;
  for (const r of candidates) { publicText += text.slice(cursor,r.start)+r.replacement; cursor=r.end; }
  return { publicText: publicText + text.slice(cursor), redactions: candidates };
}
export function displayIdentity(mode: DisplayMode, nickname: string, pseudonym?: string): string {
  if (mode === "anonymous") return "匿名知友";
  if (mode === "pseudonym") { if (!pseudonym?.trim() || pseudonym.trim().length < 2) throw new DomainError("invalid_pseudonym", "请填写 2–24 字的化名。"); return redactPII(pseudonym.trim()).publicText; }
  return redactPII(nickname).publicText;
}
export function makeExperiencePreview(input: z.infer<typeof experiencePreviewSchema>, actor: Actor, expiresAt: string) {
  const clean = experiencePreviewSchema.parse(input);
  expiresAt = new Date(expiresAt).toISOString();
  const { publicText, redactions } = redactPII(clean.text);
  const identity = displayIdentity(clean.displayMode, actor.displayName, clean.pseudonym);
  const displayAvatarUrl = clean.displayMode === "nickname" && actor.avatarUrl && isSafePublicUrl(actor.avatarUrl) ? actor.avatarUrl : null;
  const metadata = { contributionKind: clean.contributionKind??"experience", replyToProbeId:clean.replyToProbeId??null, sourceUrl:clean.sourceUrl??null, displayAvatarUrl };
  const previewHash = contentHash({ actorId: actor.id, workspaceId: actor.workspaceId, text: clean.text, publicText, displayMode: clean.displayMode, displayIdentity: identity, ...metadata, expiresAt });
  return { publicText, redactions, displayIdentity: identity, ...metadata, previewHash, expiresAt };
}
export type PublicationStatus = "pending"|"sending"|"sent"|"retryable_failed"|"permanently_failed"|"needs_reconciliation";
const publicationTransitions: Record<PublicationStatus, PublicationStatus[]> = { pending:["sending"], sending:["sent","retryable_failed","permanently_failed","needs_reconciliation"], retryable_failed:["pending"], permanently_failed:[], needs_reconciliation:["sent","permanently_failed","pending"], sent:[] };
export function assertPublicationTransition(from: PublicationStatus, to: PublicationStatus, manualVerifiedSafe = false) {
  if (!publicationTransitions[from].includes(to) || (from === "needs_reconciliation" && to === "pending" && !manualVerifiedSafe)) throw new DomainError("invalid_transition", "当前发布状态不能执行此操作，请先核对发送结果。", 409);
}
export function assertRevisionBase(baseVersionId: string, currentVersionId: string | null) { if (baseVersionId !== currentVersionId) throw new DomainError("stale_version", "答案已经有新版本，请重新审阅修订。", 409); }
export function assertEvidenceReferences(ids: string[], allowed: { id:string; visibility?:string }[]) {
  const valid = new Set(allowed.filter(x => !x.visibility || x.visibility === "public").map(x => x.id));
  if (ids.some(id => !valid.has(id))) throw new DomainError("invalid_evidence", "引用包含不属于当前议题或已不可用的证据。", 422);
}
export function versionDiff(beforeText: string, afterText: string, before: ConditionSnapshot[], after: ConditionSnapshot[], evidenceIds: string[] = [], reason = "依据新经验，更新适用条件。"): VersionDiff[] {
  const diff: VersionDiff[] = [];
  if (beforeText !== afterText) diff.push({ kind:"changed",before:beforeText,after:afterText,evidenceIds,reason });
  const key = (c:ConditionSnapshot) => c.id ?? c.label;
  for (const c of before) { const next = after.find(x => key(x) === key(c)); if (!next) diff.push({kind:"removed",conditionId:c.id,before:c.description || c.label,evidenceIds:c.evidenceIds,reason}); else if (contentHash(c) !== contentHash(next)) diff.push({kind:"changed",conditionId:c.id,before:c.description || c.label,after:next.description || next.label,evidenceIds:next.evidenceIds,reason}); }
  for (const c of after) if (!before.some(x => key(x) === key(c))) diff.push({kind:"added",conditionId:c.id,after:c.description || c.label,evidenceIds:c.evidenceIds,reason});
  return diff;
}
/** Audit values are deliberately scalar summaries, never arbitrary provider responses. */
export function safeAuditSummary(input: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const allowed = new Set(["status","decision","reasonCode","versionNumber","baseVersionId","newVersionId","evidenceCount","source","target","displayMode","providerMode","contributionKind","attemptCount","errorCode","scenarioId","duplicate"]);
  return Object.fromEntries(Object.entries(input).filter(([k,v]) => allowed.has(k) && (v === null || ["string","number","boolean"].includes(typeof v))).map(([k,v]) => [k,typeof v === "string" ? v.slice(0,300) : v])) as Record<string,string|number|boolean|null>;
}
export type ProbeStatus="draft"|"needs_review"|"approved"|"asked"|"answered"|"rejected"|"deferred"|"expired";
export function assertProbeTransition(from:ProbeStatus,to:ProbeStatus) {
 const transitions:Record<ProbeStatus,ProbeStatus[]>={draft:["approved","rejected","deferred"],needs_review:["draft","approved","rejected","deferred"],approved:["asked","expired"],asked:["answered"],answered:[],rejected:[],deferred:["draft","approved","rejected"],expired:[]};
 if(!transitions[from].includes(to))throw new DomainError("invalid_probe_transition","这条下一问的状态已改变，请重新查看。",409);
}
export type RevisionStatus="proposed"|"needs_review"|"accepted"|"rejected"|"deferred";
export function assertRevisionTransition(from:RevisionStatus,to:RevisionStatus) {
 const transitions:Record<RevisionStatus,RevisionStatus[]>={proposed:["accepted","rejected","deferred"],needs_review:["proposed","rejected","deferred"],accepted:[],rejected:[],deferred:["proposed","accepted","rejected"]};
 if(!transitions[from].includes(to))throw new DomainError("invalid_revision_transition","这份修订的状态已改变，请重新审阅。",409);
}
