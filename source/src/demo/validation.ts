import { z } from "zod";
import type { Actor, ContributionKind, DisplayMode } from "@/domain";

// Browser-only validation; no credentials or server crypto enter this module.
export class DemoError extends Error { constructor(public code:string, message:string, public status=400, public retryable=false) { super(message);this.name="DemoError"; } }
export function requireRole(actor:Actor|null, role:"contributor"|"maintainer"="contributor"): asserts actor is Actor { if(!actor)throw new DemoError("unauthenticated","请先加入演示，再记录这条经验。",401);if(role==="maintainer"&&actor.role!==role)throw new DemoError("forbidden","只有维护者可以审核这个操作。",403); }

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
  if (mode === "pseudonym") { if (!pseudonym?.trim() || pseudonym.trim().length < 2) throw new DemoError("invalid_pseudonym", "请填写 2–24 字的化名。"); return redactPII(pseudonym.trim()).publicText; }
  return redactPII(nickname).publicText;
}
export function assertRevisionBase(baseVersionId: string, currentVersionId: string | null) { if (baseVersionId !== currentVersionId) throw new DemoError("stale_version", "答案已经有新版本，请重新审阅修订。", 409); }
export function assertEvidenceReferences(ids: string[], allowed: { id:string; visibility?:string }[]) {
  const valid = new Set(allowed.filter(x => !x.visibility || x.visibility === "public").map(x => x.id));
  if (ids.some(id => !valid.has(id))) throw new DemoError("invalid_evidence", "引用包含不属于当前议题或已不可用的证据。", 422);
}
