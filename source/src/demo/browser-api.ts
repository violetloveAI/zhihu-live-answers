/**
 * GitHub Pages teaching runtime. All state belongs to this browser. This module
 * never fetches a URL, authenticates a Zhihu account or invokes a model service.
 */
import { z } from "zod";
import type * as schema from "@/db/schema";
import type { Actor, ConditionSnapshot } from "@/domain";
import type { TopicDetail } from "@/db/repository";
import type { SourceItem } from "@/providers/contracts";
import { ProviderError } from "@/providers/contracts";
import {
  publicEvidence, publicExperience, publicVersion, publicProbe, publicRevision,
  publicPublication, publicationHasUnavailableSources, hasUnavailableSources, deriveTopicStatus,
} from "@/db/projections";
import {
  DemoError, requireRole, redactPII, displayIdentity, assertEvidenceReferences,
  assertRevisionBase, demoLoginSchema, emptySchema, experiencePreviewSchema,
  experienceSubmitSchema, confirmationSchema, sourceRefreshSchema, createTopicSchema,
  probePreviewSchema, probeApproveSchema, probeDecisionSchema, revisionCreateSchema,
  revisionDecisionSchema, reportSchema, reportDecisionSchema,
} from "./validation";
import { BrowserReplayRules } from "./replay-rules";
import seedJson from "./seed.json";

type Row<T extends { $inferSelect: unknown }> = T["$inferSelect"];
type Topic = Row<typeof schema.topics>;
type Experience = Row<typeof schema.experiences>;
type Evidence = Row<typeof schema.evidence>;
type Probe = Row<typeof schema.probes>;
type Revision = Row<typeof schema.revisions>;
type Publication = Row<typeof schema.publications>;
type Version = Row<typeof schema.claimVersions>;
type Report = Row<typeof schema.reports>;
interface Tables {
  topics: Topic[]; conditions: Row<typeof schema.conditions>[]; evidence: Evidence[];
  experiences: Experience[]; matches: Row<typeof schema.matches>[]; probes: Probe[];
  revisions: Revision[]; claimVersions: Version[]; publications: Publication[];
  sourceSnapshots: Row<typeof schema.sourceSnapshots>[]; auditEvents: Row<typeof schema.auditEvents>[];
  reports: Report[];
}
interface Consent {
  id: string; purpose: string; actorId: string; expiresAt: string; used: boolean;
  input: unknown; preview: Record<string, unknown>;
}
interface Workspace {
  actor: Actor; tables: Tables; demoSeeded: boolean; consents: Consent[];
  candidates: SourceItem[];
  idempotency: Record<string, { input: string; data: unknown }>;
}
interface Store { version: 1; activeWorkspaceId: string | null; workspaces: Record<string, Workspace> }
const fixture = seedJson as unknown as { schemaVersion: 1; actor: Actor; public: Tables; demo: Tables };
export const BROWSER_DEMO_STORAGE_KEY = "live-answers:github-pages-demo:v1";
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const copy = <T,>(value: T): T => structuredClone(value);
const rules = new BrowserReplayRules();
let serial: Promise<unknown> = Promise.resolve();
const capabilities = {
  demo: true, protectedWrites: false,
  zhihuOAuth: { configured: false, profileConfigured: false, encryptionConfigured: false, available: false, status: "browser_demo_only" },
  externalPublishingRequiresLiveIdentity: true,
};

function load(): Store {
  let saved: string | null;
  try { saved = localStorage.getItem(BROWSER_DEMO_STORAGE_KEY); }
  catch { throw new DemoError("storage_unavailable", "浏览器未允许本地保存。请允许此网站使用存储后，再体验贡献与审阅。", 503); }
  if (!saved) return { version: 1, activeWorkspaceId: null, workspaces: {} };
  try {
    const value = JSON.parse(saved) as Store;
    if (value.version !== 1 || !value.workspaces || typeof value.workspaces !== "object" ||
      (value.activeWorkspaceId !== null && !value.workspaces[value.activeWorkspaceId])) throw new Error();
    return value;
  } catch { throw new DemoError("storage_invalid", "本机演示记录暂时无法读取，原记录未被覆盖。请导出或清除此网站的演示数据后再试。", 409); }
}
function save(store: Store) {
  try { localStorage.setItem(BROWSER_DEMO_STORAGE_KEY, JSON.stringify(store)); }
  catch { throw new DemoError("storage_full", "浏览器暂时无法保存这次操作，可能是存储空间不足。请释放空间后重试，原记录未改变。", 507, true); }
}
function active(store: Store): Workspace | null {
  return store.activeWorkspaceId ? store.workspaces[store.activeWorkspaceId] ?? null : null;
}
function requireWorkspace(store: Store, role: "contributor" | "maintainer" = "contributor"): Workspace {
  const workspace = active(store);
  requireRole(workspace?.actor ?? null, role);
  return workspace!;
}
function topicRecord(tables: Tables, idOrSlug: string): Topic {
  const result = tables.topics.find(topic => topic.id === idOrSlug || topic.slug === idOrSlug);
  if (!result) throw new DemoError("not_found", "没有找到这个议题。", 404);
  return result;
}
function entity<T extends { id: string }>(rows: T[], target: string, message = "没有找到这份记录。"): T {
  const result = rows.find(row => row.id === target);
  if (!result) throw new DemoError("not_found", message, 404);
  return result;
}
function topicRows<T extends { topicId: string }>(rows: T[], topicId: string) { return rows.filter(row => row.topicId === topicId); }
function sources(tables: Tables, topicId: string) { return topicRows(tables.evidence, topicId).filter(row => row.visibility === "public"); }
function current(tables: Tables, topic: Topic): Version {
  if (!topic.currentVersionId) throw new DemoError("no_current_version", "这个议题还没有公开答案，请先补充证据。", 409);
  const result = entity(tables.claimVersions, topic.currentVersionId);
  if (result.topicId !== topic.id || result.status !== "published") throw new DemoError("no_current_version", "当前版本已改变，请刷新后重试。", 409);
  return result;
}
function privacy(tables: Tables, topicId: string) {
  return { evidence: topicRows(tables.evidence, topicId), versions: topicRows(tables.claimVersions, topicId), conditions: topicRows(tables.conditions, topicId), probes: topicRows(tables.probes, topicId) };
}
function detail(tables: Tables, idOrSlug: string, actor: Actor | null): TopicDetail {
  const topic = topicRecord(tables, idOrSlug), context = privacy(tables, topic.id), maintainer = actor?.role === "maintainer";
  const versions = [...context.versions].sort((a, b) => b.versionNumber - a.versionNumber);
  const experiences = topicRows(tables.experiences, topic.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const probes = [...context.probes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const revisions = topicRows(tables.revisions, topic.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const publications = topicRows(tables.publications, topic.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const matches = tables.matches.filter(match => experiences.some(experience => experience.id === match.experienceId));
  const projected = deriveTopicStatus({ snapshots: topicRows(tables.sourceSnapshots, topic.id), experiences,
    modelRuns: [...probes.map(row => row.modelRun), ...revisions.map(row => row.modelRun), ...matches.map(row => row.modelRun)],
    probes, revisions, publications, versions, evidence: context.evidence, maintainer });
  return {
    topic: { id: topic.id, slug: topic.slug, title: topic.title, template: topic.template, summary: topic.summary, currentVersionId: topic.currentVersionId, circleId: null, status: topic.status, createdAt: topic.createdAt, updatedAt: topic.updatedAt },
    currentVersion: versions.find(row => row.id === topic.currentVersionId && row.status === "published") ? publicVersion(entity(versions, topic.currentVersionId!), context.evidence) : null,
    conditions: context.conditions.filter(condition => condition.status === "active").map(({ id, label, description, kind, evidenceIds, status }) => {
      const hidden = hasUnavailableSources(evidenceIds, context);
      return { id, label: hidden ? "来源暂不可用" : label, description: hidden ? "引用的贡献已撤回或正在审核。" : description, kind, evidenceIds, status: hidden ? "unavailable" : status };
    }),
    evidence: context.evidence.map(publicEvidence),
    experiences: experiences.map(experience => {
      const ownMatches = matches.filter(match => match.experienceId === experience.id);
      const ownHidden = context.evidence.some(source => source.experienceId === experience.id && source.visibility !== "public");
      const hidden = ownHidden || ownMatches.some(match => hasUnavailableSources([...match.evidenceIds, ...match.modelRun.inputEvidenceIds], context));
      const reply = context.probes.find(probe => probe.id === experience.replyToProbeId);
      const publicReply = reply ? publicProbe(reply, context) : null;
      return { ...publicExperience(experience, actor?.id, hidden, publicReply && !publicReply.hasUnavailableEvidence ? publicReply.question : null, ownHidden),
        matches: experience.withdrawnAt || experience.deletedAt || hidden ? [] : ownMatches.map(({ id, conditionIds, evidenceIds, relation, reasons, confidence, modelRun }) => ({ id, conditionIds, evidenceIds, relation, reasons, confidence, modelRun })) };
    }),
    probes: probes.filter(probe => maintainer || ["asked", "answered"].includes(probe.status)).map(probe => publicProbe(probe, context)),
    revisions: revisions.filter(revision => maintainer || ["accepted", "rejected", "deferred"].includes(revision.status)).map(revision => publicRevision(revision, context)),
    publications: publications.filter(publication => maintainer || publication.status === "sent").map(publication => publicPublication(publication, publicationHasUnavailableSources(publication, context))),
    versions: versions.filter(version => version.status !== "draft").map(version => publicVersion(version, context.evidence)), ...projected,
  };
}
function topicList(tables: Tables, template?: string) {
  return tables.topics.filter(topic => !template || topic.template === template).map(topic => ({ id: topic.id, slug: topic.slug, title: topic.title, summary: topic.summary, template: topic.template, currentVersionId: topic.currentVersionId, currentVersionNumber: tables.claimVersions.find(version => version.id === topic.currentVersionId)?.versionNumber ?? 0, updatedAt: topic.updatedAt }));
}
function library(tables: Tables, actor: Actor | null, demoSeeded: boolean) { return { topics: tables.topics.map(topic => detail(tables, topic.id, actor)), demoSeeded }; }
function audit(workspace: Workspace, topicId: string | null, type: string, entityType: string, entityId: string, payloadSummary: Record<string, string | number | boolean | null> = {}) {
  workspace.tables.auditEvents.unshift({ id: id(), workspaceId: workspace.actor.workspaceId, topicId, actorId: workspace.actor.id, actorMode: "replay", type, entityType, entityId, payloadSummary, occurredAt: now() });
}
function modelStatus(workspace: Workspace, topicId: string, operation: string, entityId: string) {
  workspace.tables.sourceSnapshots.push({ id: id(), workspaceId: workspace.actor.workspaceId, topicId, provider: "llm", mode: "replay", payload: { status: "ready", operation, entityId }, fetchedAt: now(), createdAt: now(), lastError: null });
}
function newWorkspace(role: Actor["role"]): Workspace {
  const workspaceId = `browser-demo-${id()}`, actor: Actor = { id: id(), workspaceId, role, mode: "replay", displayName: role === "maintainer" ? "演示维护者" : "演示贡献者", avatarUrl: null };
  const replacements = new Map<string, string>([[fixture.actor.workspaceId, workspaceId], [fixture.actor.id, actor.id], [fixture.actor.displayName, actor.displayName]]);
  for (const rows of Object.values(fixture.demo)) for (const row of rows as { id: string }[]) replacements.set(row.id, id());
  const remap = (value: unknown): unknown => typeof value === "string" ? replacements.get(value) ?? value : Array.isArray(value) ? value.map(remap) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)])) : value;
  const tables = remap(fixture.demo) as Tables;
  if (role === "contributor") { tables.revisions = []; tables.sourceSnapshots = tables.sourceSnapshots.filter(snapshot => snapshot.payload.operation !== "revision"); }
  return { actor, tables, demoSeeded: true, consents: [], candidates: [], idempotency: {} };
}
async function hash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
function getConsent(workspace: Workspace, token: string, purpose: string): Consent {
  const consent = workspace.consents.find(item => item.id === token && item.purpose === purpose && item.actorId === workspace.actor.id);
  if (!consent || consent.used || Date.parse(consent.expiresAt) < Date.now()) throw new DemoError("preview_expired", "预览已过期或已经使用，请重新检查公开内容。", 409);
  return consent;
}
function checkReply(tables: Tables, topicId: string, probeId?: string): Probe | null {
  if (!probeId) return null;
  const probe = tables.probes.find(row => row.id === probeId && row.topicId === topicId && ["asked", "answered"].includes(row.status));
  if (!probe || publicProbe(probe, privacy(tables, topicId)).hasUnavailableEvidence) throw new DemoError("reply_target_unavailable", "只能回复当前议题中已经发出且来源可查看的下一问。", 409);
  return probe;
}
async function analyze(workspace: Workspace, experience: Experience) {
  if (experience.ownerId !== workspace.actor.id && workspace.actor.role !== "maintainer") throw new DemoError("forbidden", "只有贡献者本人或维护者可以整理这份贡献。", 403);
  if (experience.withdrawnAt || experience.deletedAt || workspace.tables.evidence.some(source => source.experienceId === experience.id && source.visibility !== "public")) throw new DemoError("unavailable", "这份贡献已隐藏，不能重新整理。", 409);
  const topic = topicRecord(workspace.tables, experience.topicId);
  const evidence = sources(workspace.tables, topic.id).filter(source => source.experienceId !== experience.id).slice(0, 100);
  const conditions = topicRows(workspace.tables.conditions, topic.id).filter(condition => condition.status === "active" && !hasUnavailableSources(condition.evidenceIds, privacy(workspace.tables, topic.id))).slice(0, 100);
  const result = await rules.analyzeEvidence({ topic: { id: topic.id, title: topic.title }, experience: { id: experience.id, publicText: experience.publicText }, conditions: conditions.map(({ id, label }) => ({ id, label })), evidence: evidence.map(({ id, summary }) => ({ id, summary })) });
  experience.analysisStatus = result.status; experience.extractedConditions = result.extractedConditions; experience.caveats = result.caveats; experience.analysisError = null;
  workspace.tables.matches = workspace.tables.matches.filter(match => match.experienceId !== experience.id);
  workspace.tables.matches.push(...result.matches.map(match => ({ ...match, id: id(), workspaceId: workspace.actor.workspaceId, experienceId: experience.id, modelRun: result.modelRun, createdAt: now() })));
  modelStatus(workspace, topic.id, "analysis", experience.id); audit(workspace, topic.id, "experience.analyzed", "experience", experience.id, { status: result.status });
}
function savedExperience(workspace: Workspace, experience: Experience) {
  const projected = entity(detail(workspace.tables, experience.topicId, workspace.actor).experiences, experience.id);
  return { experience: projected, matches: projected.matches, analysisStatus: projected.analysisStatus };
}
async function proposeRevision(workspace: Workspace, topic: Topic, evidenceIds: string[]) {
  requireRole(workspace.actor, "maintainer");
  const version = current(workspace.tables, topic), evidence = sources(workspace.tables, topic.id), ids = [...new Set(evidenceIds)].sort();
  assertEvidenceReferences(ids, evidence);
  const duplicate = workspace.tables.revisions.find(revision => revision.topicId === topic.id && revision.baseVersionId === version.id && JSON.stringify([...revision.evidenceIds].sort()) === JSON.stringify(ids));
  if (duplicate) return { revision: publicRevision(duplicate, privacy(workspace.tables, topic.id)), duplicate: true };
  if (publicVersion(version, topicRows(workspace.tables.evidence, topic.id)).hasUnavailableEvidence) throw new DemoError("invalid_evidence", "当前答案含有暂不可用的来源，请先核对相关反馈与贡献。", 409);
  const oldConditions = topicRows(workspace.tables.conditions, topic.id).filter(condition => condition.status === "active");
  const selected = evidence.filter(source => ids.includes(source.id));
  const proposed = await rules.proposeRevision({ topicId: topic.id, baseVersionId: version.id, currentText: version.text, currentConditions: oldConditions.map(({ id, label }) => ({ id, label })), newEvidence: selected.map(({ id, summary }) => ({ id, summary })) });
  const proposedConditions: ConditionSnapshot[] = proposed.proposedConditions.map(condition => {
    const old = oldConditions.find(existing => existing.label === condition.label);
    return { ...condition, id: old?.id ?? id(), description: old?.description ?? condition.label, kind: old?.kind ?? "context", status: "active", evidenceIds: condition.evidenceIds.length ? condition.evidenceIds : old?.evidenceIds ?? [] };
  });
  const revision: Revision = { ...proposed, id: id(), workspaceId: workspace.actor.workspaceId, topicId: topic.id, baseVersionId: version.id, proposedConditions, evidenceIds: ids, contributorIds: [...new Set(selected.flatMap(source => source.experienceId ? workspace.tables.experiences.filter(experience => experience.id === source.experienceId).map(experience => experience.ownerId) : []))], reviewerId: null, decidedAt: null, decisionReason: null, acceptedVersionId: null, createdAt: now() };
  workspace.tables.revisions.push(revision); audit(workspace, topic.id, "revision.proposed", "revision", revision.id, { baseVersionId: version.id, evidenceCount: ids.length }); modelStatus(workspace, topic.id, "revision", revision.id);
  return { revision: publicRevision(revision, privacy(workspace.tables, topic.id)), duplicate: false };
}
function publicReport(report: Report) { const { id, topicId, entityType, entityId, reason, status, createdAt, resolvedAt, decisionReason } = report; return { id, topicId, entityType, entityId, reason, status, createdAt, resolvedAt, decisionReason }; }
function reportTarget(tables: Tables, kind: string, target: string): { topicId: string; evidenceIds: string[] } {
  if (kind === "evidence") { const row = entity(tables.evidence, target); return { topicId: row.topicId, evidenceIds: [row.id] }; }
  if (kind === "experience") { const row = entity(tables.experiences, target); return { topicId: row.topicId, evidenceIds: tables.evidence.filter(source => source.experienceId === row.id).map(source => source.id) }; }
  const row = kind === "probe" ? entity(tables.probes, target) : kind === "revision" ? entity(tables.revisions, target) : kind === "version" ? entity(tables.claimVersions, target) : null;
  if (!row) throw new DemoError("not_found", "没有找到要反馈的内容。", 404);
  return { topicId: row.topicId, evidenceIds: row.evidenceIds };
}
const sourceSamples: Pick<SourceItem, "sourceId" | "type" | "title" | "summary" | "author">[] = [
  { sourceId: "browser:prototype-01", type: "search", title: "零基础借助 AI 完成展示原型（演示）", summary: "我用 AI 在一周内完成了可点击原型。它仅用于展示，没有接入真实支付、用户账号或长期维护。", author: { displayName: "演示贡献者小林" } },
  { sourceId: "browser:production-02", type: "search", title: "产品上线之后才遇到的问题（演示）", summary: "上线后开始有真实用户，错误日志、数据备份与安全检查占了大部分时间。我需要先理解代码才能稳定修复故障。", author: { displayName: "演示贡献者阿禾" } },
  { sourceId: "browser:learning-03", type: "hot", title: "学习编程时，如何判断自己真的理解了？（演示）", summary: "关注在新任务中独立排查错误、解释代码与验证结果的能力。", author: { displayName: "教学资料整理" } },
];
function candidateSamples(query?: string): SourceItem[] {
  return sourceSamples.filter(item => query ? item.type === "search" : item.type === "hot").map(item => ({ ...item, provenance: { provider: "replay", mode: "replay", fetchedAt: now(), sourceNature: "synthetic" } }));
}
async function createSource(workspace: Workspace, topicId: string, item: SourceItem): Promise<Evidence> {
  const row: Evidence = { id: id(), workspaceId: workspace.actor.workspaceId, topicId, sourceType: "replay", provider: "replay", sourceId: item.sourceId, url: item.url ?? null, title: item.title ?? null, summary: item.summary, displayAuthor: item.author?.displayName ?? "教学资料整理", fetchedAt: item.provenance.fetchedAt, contentHash: await hash(item.summary), visibility: "public", provenance: item.provenance, experienceId: null, createdAt: now() };
  workspace.tables.evidence.push(row); return row;
}

async function dispatch(store: Store, path: string, body: unknown, method: string): Promise<unknown> {
  const url = new URL(path.replace(/^\/api\//, ""), "https://browser-demo.invalid/"), segments = url.pathname.split("/").filter(Boolean).map(segment => decodeURIComponent(segment));
  const workspace = active(store), actor = workspace?.actor ?? null, tables = workspace?.tables ?? fixture.public;
  if (method === "GET" && path === "auth/session") return { user: actor, capabilities };
  if (method === "POST" && path === "auth/demo") {
    const { role } = demoLoginSchema.parse(body), created = newWorkspace(role);
    store.workspaces[created.actor.workspaceId] = created; store.activeWorkspaceId = created.actor.workspaceId;
    return { user: created.actor };
  }
  if (method === "POST" && path === "auth/logout") { emptySchema.parse(body); store.activeWorkspaceId = null; return { loggedOut: true, scope: "this_application" }; }
  if (method === "GET" && path === "health") return { status: "ok", runtime: "browser-demo", storage: "localStorage", externalRequests: false };
  if (method === "GET" && path === "library") return library(tables, actor, workspace?.demoSeeded ?? false);
  if (method === "POST" && path === "demo/library") { const own = requireWorkspace(store); emptySchema.parse(body); return library(own.tables, own.actor, own.demoSeeded); }
  if (segments[0] === "topics" && method === "GET") {
    if (segments.length === 1) { const template = url.searchParams.get("template"); if (template) z.enum(["learning", "social"]).parse(template); return topicList(tables, template ?? undefined); }
    if (segments[1] === "candidates" && segments.length === 2) {
      const own = requireWorkspace(store, "maintainer"), query = url.searchParams.has("query") ? z.string().trim().min(1).max(200).parse(url.searchParams.get("query")) : undefined;
      const result = candidateSamples(query); own.candidates = [...own.candidates.filter(previous => !result.some(item => item.sourceId === previous.sourceId)), ...result];
      return { candidates: result.map(item => ({ ...item, candidateId: item.sourceId })), dataStatus: { mode: "replay", status: "ready", fetchedAt: now() }, filteredCount: 0 };
    }
    const topic = topicRecord(tables, segments[1]);
    if (segments.length === 2) return detail(tables, topic.id, actor);
    if (segments.length === 3 && segments[2] === "versions") return detail(tables, topic.id, actor).versions;
    if (segments.length === 3 && segments[2] === "audit") { requireWorkspace(store, "maintainer"); return topicRows(tables.auditEvents.filter(event => event.topicId !== null) as (Row<typeof schema.auditEvents> & { topicId: string })[], topic.id).map(({ id, type, entityType, entityId, payloadSummary, occurredAt, actorMode }) => ({ id, type, entityType, entityId, payloadSummary, occurredAt, actorMode })); }
    if (segments.length === 3 && segments[2] === "reports") { requireWorkspace(store, "maintainer"); return topicRows(tables.reports, topic.id).map(publicReport); }
  }
  if (method === "GET" && segments[0] === "reports" && segments.length === 1) { const own = requireWorkspace(store, "maintainer"); return own.tables.reports.filter(report => !url.searchParams.get("topicId") || report.topicId === url.searchParams.get("topicId")).map(publicReport); }
  if (method === "GET" && segments[0] === "publications" && segments.length === 2) { const own = requireWorkspace(store, "maintainer"), publication = entity(own.tables.publications, segments[1]); return publicPublication(publication, publicationHasUnavailableSources(publication, privacy(own.tables, publication.topicId))); }
  if (method === "POST" && segments[0] === "topics" && segments.length === 1) {
    const own = requireWorkspace(store, "maintainer"), input = createTopicSchema.parse(body);
    if (!input.sourceEvidenceIds.length) throw new DemoError("source_required", "请先选择至少一条已读取的演示来源。", 400);
    const selected = [...new Set(input.sourceEvidenceIds)].map(sourceId => own.candidates.find(item => item.sourceId === sourceId));
    if (selected.some(item => !item)) throw new DemoError("source_not_available", "选中的来源已不可用，请重新读取后选择。", 409);
    const topicId = id(), versionId = id(), timestamp = now();
    const topic: Topic = { id: topicId, workspaceId: own.actor.workspaceId, slug: `topic-${topicId.slice(0, 8)}`, title: redactPII(input.title).publicText, template: input.template, summary: "这个议题正在收集不同条件下的具体经验，下一条贡献可能让答案更清楚。", currentVersionId: versionId, creatorId: own.actor.id, circleId: null, status: "active", createdAt: timestamp, updatedAt: timestamp };
    own.tables.topics.push(topic);
    const evidenceIds = [] as string[];
    for (const item of selected) evidenceIds.push((await createSource(own, topic.id, item!)).id);
    const condition = { id: id(), workspaceId: own.actor.workspaceId, topicId, label: "哪些条件会改变这个结论？", description: "现有摘要尚不足以确认适用条件，欢迎补充行动、限制与实际结果。", kind: "unknown" as const, evidenceIds, status: "active" };
    own.tables.conditions.push(condition);
    const snapshot: ConditionSnapshot = { id: condition.id, label: condition.label, description: condition.description, kind: condition.kind, evidenceIds, status: "active" };
    own.tables.claimVersions.push({ id: versionId, workspaceId: own.actor.workspaceId, topicId, versionNumber: 1, baseVersionId: null, text: "这个问题仍在收集经验。目前的材料不足以给出统一结论；请先区分具体条件，再用可追溯的经历逐步补充。", conditionsSnapshot: [snapshot], evidenceIds, contributorDisplaySnapshot: [], reviewerId: own.actor.id, createdAt: timestamp, publishedAt: timestamp, status: "published" });
    audit(own, topic.id, "topic.created", "topic", topic.id, { evidenceCount: evidenceIds.length });
    return { topic: topicList(own.tables).find(item => item.id === topic.id) };
  }
  if (method === "POST" && segments[0] === "topics" && segments.length >= 3) {
    const own = requireWorkspace(store), topic = topicRecord(own.tables, segments[1]);
    if (segments[2] === "experiences" && segments[3] === "preview" && segments.length === 4) {
      const input = experiencePreviewSchema.parse(body), reply = checkReply(own.tables, topic.id, input.replyToProbeId), redacted = redactPII(input.text), expiresAt = new Date(Date.now() + 15 * 60_000).toISOString(), token = id();
      const preview = { ...redacted, displayIdentity: displayIdentity(input.displayMode, own.actor.displayName, input.pseudonym), displayAvatarUrl: null, previewHash: token, expiresAt, contributionKind: input.contributionKind ?? "experience", replyToProbeId: input.replyToProbeId ?? null, replyToProbeQuestion: reply?.question ?? null, sourceUrl: input.sourceUrl ?? null, sourceVerification: input.sourceUrl ? "user_provided_unverified" : null };
      own.consents.push({ id: token, purpose: `experience:${topic.id}`, actorId: own.actor.id, expiresAt, used: false, input: await hash(input), preview });
      return preview;
    }
    if (segments[2] === "experiences" && segments.length === 3) {
      const input = experienceSubmitSchema.parse(body), consent = getConsent(own, input.previewHash, `experience:${topic.id}`);
      const { publicText, previewHash: _token, confirmed: _confirmed, ...original } = input;
      if (await hash(original) !== consent.input || publicText !== consent.preview.publicText) throw new DemoError("preview_changed", "提交内容与刚才确认的预览不同，请重新预览。", 409);
      const reply = checkReply(own.tables, topic.id, input.replyToProbeId), timestamp = now();
      const experience: Experience = { id: id(), workspaceId: own.actor.workspaceId, topicId: topic.id, ownerId: own.actor.id, rawText: input.text, publicText, displayMode: input.displayMode, displayName: String(consent.preview.displayIdentity), displayAvatarUrl: null, contributionKind: input.contributionKind ?? "experience", replyToProbeId: input.replyToProbeId ?? null, sourceUrl: input.sourceUrl ?? null, consentId: consent.id, analysisStatus: "pending", analysisError: null, extractedConditions: [], caveats: [], createdAt: timestamp, withdrawnAt: null, deletedAt: null };
      own.tables.experiences.push(experience);
      own.tables.evidence.push({ id: id(), workspaceId: own.actor.workspaceId, topicId: topic.id, sourceType: "experience", provider: "experience", sourceId: experience.id, url: experience.sourceUrl, title: experience.contributionKind === "evidence" ? "用户提供的参考链接（未经验证）" : experience.contributionKind === "comment" ? "一条新的讨论补充" : "一份新的亲身经历", summary: publicText, displayAuthor: experience.displayName, fetchedAt: timestamp, contentHash: await hash(publicText), visibility: "public", provenance: { provider: "experience", mode: "replay", fetchedAt: timestamp, ...(experience.sourceUrl ? { sourceNature: "user_provided" as const } : {}) }, experienceId: experience.id, createdAt: timestamp });
      consent.used = true; if (reply?.status === "asked") reply.status = "answered";
      audit(own, topic.id, "experience.submitted", "experience", experience.id, { contributionKind: experience.contributionKind, displayMode: experience.displayMode });
      await analyze(own, experience); return savedExperience(own, experience);
    }
    if (segments[2] === "refresh" && segments.length === 3) {
      requireRole(own.actor, "maintainer"); const input = sourceRefreshSchema.parse(body);
      if (input.source !== "search") throw new DemoError("unsupported", "比赛演示不包含圈子能力，只支持教学搜索来源。", 400);
      const selected = candidateSamples(input.query ?? topic.title), addedEvidenceIds: string[] = []; let duplicateCount = 0;
      for (const item of selected) { if (own.tables.evidence.some(source => source.topicId === topic.id && source.sourceId === item.sourceId && source.summary === item.summary)) duplicateCount++; else addedEvidenceIds.push((await createSource(own, topic.id, item)).id); }
      own.tables.sourceSnapshots.push({ id: id(), workspaceId: own.actor.workspaceId, topicId: topic.id, provider: "search", mode: "replay", payload: { status: "ready", itemCount: selected.length }, fetchedAt: now(), createdAt: now(), lastError: null });
      audit(own, topic.id, "source.refreshed", "topic", topic.id, { source: "search", evidenceCount: addedEvidenceIds.length });
      return { addedEvidenceCount: addedEvidenceIds.length, addedEvidenceIds, duplicateCount, errors: [], providerMode: "replay", dataStatus: detail(own.tables, topic.id, own.actor).dataStatus };
    }
    if (segments[2] === "probes" && segments.length === 3) {
      requireRole(own.actor, "maintainer"); emptySchema.parse(body); const version = current(own.tables, topic);
      const unknowns = detail(own.tables, topic.id, own.actor).conditions.filter(condition => condition.kind === "unknown" && condition.status === "active");
      if (!unknowns.length) throw new DemoError("no_unknowns", "目前没有可用的待验证条件，先核对来源或补充证据吧。", 409);
      const result = await rules.proposeProbe({ topicId: topic.id, baseVersionId: version.id, unknowns: unknowns.map(({ id, label }) => ({ id, label })), evidence: sources(own.tables, topic.id).slice(0, 100).map(({ id, summary }) => ({ id, summary })) });
      const probe: Probe = { ...result, id: id(), workspaceId: own.actor.workspaceId, topicId: topic.id, baseVersionId: version.id, reviewerId: null, approvedAt: null, createdAt: now(), decisionReason: null };
      own.tables.probes.push(probe); audit(own, topic.id, "probe.proposed", "probe", probe.id); modelStatus(own, topic.id, "probe", probe.id);
      return { probe: publicProbe(probe, privacy(own.tables, topic.id)) };
    }
    if (segments[2] === "revisions" && segments.length === 3) { const input = revisionCreateSchema.parse(body); return proposeRevision(own, topic, input.evidenceIds); }
  }
  if (segments[0] === "experiences" && ((method === "POST" && segments.length === 3) || (method === "DELETE" && segments.length === 2))) {
    const own = requireWorkspace(store), experience = entity(own.tables.experiences, segments[1]);
    if (method === "POST" && segments[2] === "reanalyze") { emptySchema.parse(body); await analyze(own, experience); return savedExperience(own, experience); }
    if (method === "DELETE" || segments[2] === "withdraw") {
      confirmationSchema.parse(body); if (experience.ownerId !== own.actor.id) throw new DemoError("forbidden", "只有贡献者本人可以撤回或删除。", 403);
      const remove = method === "DELETE"; experience.withdrawnAt ??= now(); if (remove) { experience.deletedAt ??= now(); experience.rawText = null; }
      experience.publicText = "[这份经历已撤回]"; experience.displayName = "已撤回的知友"; experience.sourceUrl = null; experience.displayAvatarUrl = null; experience.extractedConditions = []; experience.caveats = []; experience.analysisStatus = "needs_review"; experience.analysisError = null;
      for (const source of own.tables.evidence.filter(row => row.experienceId === experience.id)) { source.visibility = "unavailable"; source.summary = "[来源已撤回]"; source.displayAuthor = "已撤回的知友"; }
      own.tables.matches = own.tables.matches.filter(match => match.experienceId !== experience.id);
      own.consents = own.consents.filter(consent => consent.id !== experience.consentId);
      audit(own, experience.topicId, remove ? "experience.deleted" : "experience.withdrawn", "experience", experience.id);
      return { id: experience.id, status: remove ? "deleted" : "withdrawn" };
    }
  }
  if (method === "POST" && segments[0] === "probes" && segments.length === 3) {
    const own = requireWorkspace(store, "maintainer"), probe = entity(own.tables.probes, segments[1]), topic = topicRecord(own.tables, probe.topicId);
    if (segments[2] === "decision") {
      const input = probeDecisionSchema.parse(body);
      if (!["draft", "needs_review", "deferred"].includes(probe.status)) throw new DemoError("already_reviewed", "这条下一问已经处理。", 409);
      probe.status = input.decision === "reject" ? "rejected" : "deferred"; probe.reviewerId = own.actor.id; probe.decisionReason = redactPII(input.reason ?? "").publicText;
      audit(own, topic.id, "probe.reviewed", "probe", probe.id, { decision: input.decision }); return { probe: publicProbe(probe, privacy(own.tables, topic.id)) };
    }
    if (segments[2] === "preview" || segments[2] === "approve") {
      const input = segments[2] === "preview" ? probePreviewSchema.parse(body) : probeApproveSchema.parse(body);
      assertRevisionBase(probe.baseVersionId, topic.currentVersionId);
      if (!["draft", "needs_review", "deferred"].includes(probe.status)) throw new DemoError("already_reviewed", "这条下一问已经处理，请刷新后查看。", 409);
      if (input.target !== "in_app") throw new DemoError("publishing_disabled", "GitHub Pages 演示只保存在本浏览器，不会向知乎发送内容。", 403);
      if (publicProbe(probe, privacy(own.tables, topic.id)).hasUnavailableEvidence) throw new DemoError("invalid_evidence", "引用内容暂不可用，请先核对来源。", 409);
      const identity = displayIdentity(input.displayMode, own.actor.displayName, input.pseudonym), question = redactPII(input.question ?? probe.question).publicText;
      const sourceUrls = sources(own.tables, topic.id).filter(source => probe.evidenceIds.includes(source.id) && source.url).map(source => source.url!).sort();
      const payload = { text: `${question}\n\n—— ${identity} · 活答案，与刘看山一起追问\n${sourceUrls.length ? `参考来源：\n${sourceUrls.join("\n")}` : "这是一条邀请分享亲身经历的问题，仍有待验证。"}`, target: "in_app" as const, displayIdentity: identity, sourceUrls, baseVersionId: probe.baseVersionId, evidenceIds: [...probe.evidenceIds] };
      if (segments[2] === "preview") {
        const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString(), token = id(), preview = { ...payload, previewHash: token, expiresAt, providerMode: "replay" };
        own.consents.push({ id: token, purpose: `probe:${probe.id}`, actorId: own.actor.id, expiresAt, used: false, input: await hash(input), preview }); return preview;
      }
      const approved = probeApproveSchema.parse(body), consent = getConsent(own, approved.previewHash, `probe:${probe.id}`);
      const { previewHash: _hash, confirmed: _confirmed, ...original } = approved;
      if (await hash(original) !== consent.input || payload.text !== consent.preview.text || JSON.stringify(sourceUrls) !== JSON.stringify(consent.preview.sourceUrls)) throw new DemoError("preview_changed", "内容、身份或依据与刚才预览不一致，请重新确认。", 409);
      const publication: Publication = { id: id(), workspaceId: own.actor.workspaceId, topicId: topic.id, probeId: probe.id, approvalId: consent.id, approvedById: own.actor.id, providerMode: "replay", targetCircleId: null, immutablePayload: payload, previewHash: consent.id, idempotencyKey: consent.id, status: "pending", attemptCount: 0, nextAttemptAt: now(), leaseOwner: null, leaseUntil: null, remoteId: null, remoteUrl: null, lastError: null, createdAt: now(), sentAt: null };
      own.tables.publications.push(publication); consent.used = true; probe.question = question; probe.status = "approved"; probe.approvedAt = now(); probe.reviewerId = own.actor.id;
      audit(own, topic.id, "probe.approved", "probe", probe.id, { target: "in_app" }); audit(own, topic.id, "publication.requested", "publication", publication.id, { target: "in_app", status: "pending" });
      return { probe: publicProbe(probe, privacy(own.tables, topic.id)), publication: publicPublication(publication) };
    }
  }
  if (method === "POST" && segments[0] === "publications" && segments.length === 3 && ["process", "retry"].includes(segments[2])) {
    const own = requireWorkspace(store, "maintainer"), publication = entity(own.tables.publications, segments[1]), probe = entity(own.tables.probes, publication.probeId);
    segments[2] === "retry" ? confirmationSchema.parse(body) : emptySchema.parse(body);
    const publicationTopic = topicRecord(own.tables, publication.topicId);
    if (publication.status !== "sent" && (publicationTopic.status !== "active" || probe.baseVersionId !== publicationTopic.currentVersionId || publication.immutablePayload.baseVersionId !== publicationTopic.currentVersionId)) {
      publication.status = "permanently_failed"; publication.lastError = "答案版本已经更新，原发送确认已失效，请重新审阅下一问。"; publication.nextAttemptAt = null;
      if (probe.status === "approved") probe.status = "expired";
      audit(own, publication.topicId, "publication.cancelled", "publication", publication.id, { status: publication.status, reasonCode: "stale_publication" });
      return { publication: publicPublication(publication, publicationHasUnavailableSources(publication, privacy(own.tables, publication.topicId))) };
    }
    if (publicationHasUnavailableSources(publication, privacy(own.tables, publication.topicId))) throw new DemoError("invalid_evidence", "相关来源已不可用，下一问不能继续发出。", 409);
    if (!["pending", "sending", "retryable_failed", "sent"].includes(publication.status)) throw new DemoError("invalid_state", "这条发送记录需要先核对，不能自动重试。", 409);
    if (publication.status !== "sent") { publication.status = "sent"; publication.attemptCount++; publication.nextAttemptAt = null; publication.sentAt = now(); publication.remoteId = `browser-local-${publication.id}`; publication.remoteUrl = null; publication.lastError = null; if (probe.status === "approved") probe.status = "asked"; audit(own, publication.topicId, "publication.sent", "publication", publication.id, { target: "in_app", providerMode: "replay" }); }
    return { publication: publicPublication(publication) };
  }
  if (method === "POST" && segments[0] === "revisions" && segments[2] === "decision" && segments.length === 3) {
    const own = requireWorkspace(store, "maintainer"), input = revisionDecisionSchema.parse(body), revision = entity(own.tables.revisions, segments[1]), topic = topicRecord(own.tables, revision.topicId);
    if (["accepted", "rejected"].includes(revision.status)) throw new DemoError("already_reviewed", "这份修订已经处理。", 409);
    assertRevisionBase(input.baseVersionId, revision.baseVersionId);
    if (input.decision === "accept") {
      if (!["proposed", "deferred"].includes(revision.status)) throw new DemoError("invalid_revision_state", "这条修订还不能接受，请先核对证据。", 409);
      assertRevisionBase(revision.baseVersionId, topic.currentVersionId);
      const context = privacy(own.tables, topic.id), available = sources(own.tables, topic.id);
      if (publicRevision(revision, context).hasUnavailableEvidence) throw new DemoError("invalid_evidence", "相关来源暂不可用，请先核对贡献和内容反馈。", 409);
      assertEvidenceReferences(revision.evidenceIds, available); for (const condition of revision.proposedConditions) assertEvidenceReferences(condition.evidenceIds, available);
      if (own.tables.reports.some(report => report.status === "pending" && (report.entityId === revision.id || reportTarget(own.tables, report.entityType, report.entityId).evidenceIds.some(sourceId => revision.evidenceIds.includes(sourceId))))) throw new DemoError("reported_evidence", "相关内容反馈尚待核对，暂不能发布新结论。", 409);
      const base = current(own.tables, topic), timestamp = now(), versionId = id();
      const nextConditions = revision.proposedConditions.map(condition => ({ ...condition, id: condition.id ?? id(), description: condition.description ?? condition.label, kind: condition.kind ?? "context" as const, status: condition.status ?? "active" }));
      for (const condition of topicRows(own.tables.conditions, topic.id)) condition.status = "superseded";
      for (const condition of nextConditions) { const existing = own.tables.conditions.find(item => item.id === condition.id); if (existing && existing.topicId !== topic.id) throw new DemoError("invalid_condition", "修订包含其他议题的条件。", 409); if (existing) Object.assign(existing, condition); else own.tables.conditions.push({ ...condition, workspaceId: own.actor.workspaceId, topicId: topic.id }); }
      base.status = "superseded";
      const version: Version = { id: versionId, workspaceId: own.actor.workspaceId, topicId: topic.id, versionNumber: base.versionNumber + 1, baseVersionId: base.id, text: revision.proposedText, conditionsSnapshot: nextConditions, evidenceIds: [...new Set([...base.evidenceIds, ...revision.evidenceIds])].filter(sourceId => available.some(source => source.id === sourceId)), contributorDisplaySnapshot: [...new Set([...base.contributorDisplaySnapshot, ...available.filter(source => revision.evidenceIds.includes(source.id)).map(source => source.displayAuthor)])], reviewerId: own.actor.id, createdAt: timestamp, publishedAt: timestamp, status: "published" };
      own.tables.claimVersions.push(version); topic.currentVersionId = versionId; topic.updatedAt = timestamp; revision.status = "accepted"; revision.acceptedVersionId = versionId;
      audit(own, topic.id, "revision.accepted", "revision", revision.id, { baseVersionId: base.id, newVersionId: versionId, versionNumber: version.versionNumber, evidenceCount: revision.evidenceIds.length });
    } else { revision.status = input.decision === "reject" ? "rejected" : "deferred"; audit(own, topic.id, "revision.reviewed", "revision", revision.id, { decision: input.decision }); }
    revision.reviewerId = own.actor.id; revision.decidedAt = now(); revision.decisionReason = redactPII(input.reason ?? "").publicText;
    const projected = detail(own.tables, topic.id, own.actor); return { revision: entity(projected.revisions, revision.id), currentVersion: projected.currentVersion };
  }
  if (method === "POST" && segments[0] === "reports" && segments.length === 1) {
    const own = requireWorkspace(store), input = reportSchema.parse(body), target = reportTarget(own.tables, input.entityType, input.entityId);
    const duplicate = own.tables.reports.find(report => report.reporterId === own.actor.id && report.entityType === input.entityType && report.entityId === input.entityId && report.status === "pending");
    if (duplicate) return { report: publicReport(duplicate) };
    const report: Report = { ...input, id: id(), workspaceId: own.actor.workspaceId, topicId: target.topicId, reporterId: own.actor.id, reason: redactPII(input.reason).publicText, status: "pending", createdAt: now(), reviewerId: null, resolvedAt: null, decisionReason: null };
    own.tables.reports.push(report); for (const source of own.tables.evidence.filter(row => target.evidenceIds.includes(row.id) && row.visibility === "public")) source.visibility = "quarantined";
    audit(own, target.topicId, "content.reported", input.entityType, input.entityId, { status: "pending" }); return { report: publicReport(report) };
  }
  if (method === "POST" && segments[0] === "reports" && segments[2] === "decision" && segments.length === 3) {
    const own = requireWorkspace(store, "maintainer"), input = reportDecisionSchema.parse(body), report = entity(own.tables.reports, segments[1]), target = reportTarget(own.tables, report.entityType, report.entityId);
    if (report.status !== "pending") throw new DemoError("already_reviewed", "这条内容反馈已经处理。", 409);
    report.status = input.decision === "hide" ? "hidden" : "dismissed"; report.reviewerId = own.actor.id; report.resolvedAt = now(); report.decisionReason = redactPII(input.reason).publicText;
    for (const source of own.tables.evidence.filter(row => target.evidenceIds.includes(row.id))) {
      if (input.decision === "hide") source.visibility = "unavailable";
      else if (source.visibility === "quarantined") {
        const stillBlocked = own.tables.reports.some(other => ["pending", "hidden"].includes(other.status) && reportTarget(own.tables, other.entityType, other.entityId).evidenceIds.includes(source.id));
        const experience = source.experienceId ? own.tables.experiences.find(row => row.id === source.experienceId) : null;
        if (!stillBlocked && (!source.experienceId || (experience && !experience.withdrawnAt && !experience.deletedAt))) source.visibility = "public";
      }
    }
    audit(own, report.topicId, "report.reviewed", "report", report.id, { decision: input.decision, status: report.status }); return { report: publicReport(report) };
  }
  throw new DemoError("not_found", "演示中没有找到这个操作。", 404);
}

// Idempotency retains entity references, never copies of removed text or raw input.
function responseReference(data: unknown) {
  const value = data as { experience?: { id: string; topicId: string }; revision?: { id: string; topicId: string }; probe?: { id: string; topicId: string }; publication?: { id: string } };
  if (value.experience) return { kind: "experience", topicId: value.experience.topicId, id: value.experience.id };
  if (value.revision) return { kind: "revision", topicId: value.revision.topicId, id: value.revision.id };
  if (value.probe && value.publication) return { kind: "approval", topicId: value.probe.topicId, id: value.probe.id, publicationId: value.publication.id };
  throw new DemoError("invalid_result", "这次操作没有完整保存，请重试。", 500, true);
}
function cachedResponse(workspace: Workspace, reference: unknown) {
  const value = reference as { kind: string; topicId: string; id: string; publicationId?: string };
  const projected = detail(workspace.tables, value.topicId, workspace.actor);
  if (value.kind === "experience") { const experience = entity(projected.experiences, value.id); return { experience, matches: experience.matches, analysisStatus: experience.analysisStatus }; }
  if (value.kind === "revision") return { revision: entity(projected.revisions, value.id), currentVersion: projected.currentVersion };
  if (value.kind === "approval") return { probe: entity(projected.probes, value.id), publication: entity(projected.publications, value.publicationId!) };
  throw new DemoError("invalid_result", "这条重试记录暂时无法读取，请重新预览。", 409);
}

/** Returns the same envelope as the server transport; the original UI error handling stays intact. */
export function browserResponse(path: string, body: unknown, method = body === undefined ? "GET" : "POST", idempotencyKey?: string): Promise<Response> {
  const execute = async (): Promise<Response> => {
    try {
      const store = load(), work = active(store), input = await hash(body ?? null);
      const idempotent = method === "POST" && (/^topics\/[^/]+\/experiences$/.test(path) || /^probes\/[^/]+\/approve$/.test(path) || /^revisions\/[^/]+\/decision$/.test(path));
      if (idempotent && (!idempotencyKey || !/^[A-Za-z0-9_.:-]{8,160}$/.test(idempotencyKey))) throw new DemoError("missing_idempotency_key", "缺少请求标识，请刷新后再试。", 400);
      const key = `${method}:${path}:${idempotencyKey ?? ""}`, previous = idempotent ? work?.idempotency[key] : undefined;
      if (previous) { if (previous.input !== input) throw new DemoError("idempotency_conflict", "同一请求编号的内容已经改变，请重新确认。", 409); return Response.json({ data: cachedResponse(work!, previous.data) }); }
      const data = await dispatch(store, path, body, method);
      if (idempotent && work) work.idempotency[key] = { input, data: responseReference(data) };
      if (method !== "GET" || path.startsWith("topics/candidates")) save(store);
      return Response.json({ data: copy(data) }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof z.ZodError) return Response.json({ error: { code: "invalid_input", message: error.issues.map(issue => issue.message).join("；"), retryable: false } }, { status: 400 });
      if (error instanceof DemoError) return Response.json({ error: { code: error.code, message: error.message, retryable: error.retryable } }, { status: error.status });
      if (error instanceof ProviderError) return Response.json({ error: { code: `provider_${error.kind}`, message: error.message, retryable: error.retryable } }, { status: 422 });
      return Response.json({ error: { code: "browser_demo_error", message: "这次演示操作未完成，原记录没有改变。请刷新后重试。", retryable: true } }, { status: 500 });
    }
  };
  const run = async (): Promise<Response> => typeof navigator !== "undefined" && navigator.locks ? await navigator.locks.request(BROWSER_DEMO_STORAGE_KEY, execute) : await execute();
  const result = serial.then(run, run); serial = result.then(() => undefined, () => undefined); return result;
}
