import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { AppDb } from "../db";
import { getDatabase } from "../db";
import { appendAudit } from "../db/repository";
import { publicationHasUnavailableSources, publicPublication } from "../db/projections";
import * as t from "../db/schema";
import { assertEvidenceReferences, contentHash, DomainError, equalHash, PUBLIC_WORKSPACE, requireRole, type Actor } from "../domain";
import { ProviderError, publishReceiptSchema, type PublishReceipt, type ZhihuProvider } from "../providers/contracts";
import { CIRCLE_PUBLICATION_TITLE, createZhihuProvider, hashPublishPayload } from "../providers/zhihu";
import { getPublicationPolicy } from "./publication-policy";
import { currentUserRole } from "./roles";

/** A crash after this reservation may already have sent bytes. Never reclaim live sends. */
const LEASE_MS = 60_000;
const ATTEMPT_EVENT = "publication.delivery_attempted";
type Publication = typeof t.publications.$inferSelect;
interface Clock { now?: () => Date }
export interface OutboxOptions extends Clock {
  db?: AppDb;
  limit?: number;
  /** Trusted server scope for resuming one previously approved task from a request. */
  scope?: { workspaceId: string; publicationId: string };
  workerId?: string;
  leaseMs?: number;
  /** Server/test dependency injection. It must return the requested mode. */
  providerFactory?: (mode: "live" | "replay") => ZhihuProvider;
}
export interface OutboxResult {
  processed: number; sent: number; failed: number; needsReconciliation: number;
  recovered: number; rateLimited: number;
}

async function databaseNow(db: AppDb, clock: Clock): Promise<Date> {
  if (clock.now) return clock.now();
  const [row] = await db.select({ now: sql<string>`clock_timestamp()::text` }).from(t.workspaces).where(eq(t.workspaces.id, PUBLIC_WORKSPACE)).limit(1);
  if (!row || !Number.isFinite(new Date(row.now).getTime())) throw new DomainError("worker_not_initialized", "发布队列尚未完成数据库初始化。", 503);
  return new Date(row.now);
}
/** Every worker takes this row first: a transaction-scoped global app queue/rate mutex. */
async function lockAppQueue(db: AppDb): Promise<void> {
  const [lock] = await db.select({ id: t.workspaces.id }).from(t.workspaces).where(eq(t.workspaces.id, PUBLIC_WORKSPACE)).for("update");
  if (!lock) throw new DomainError("worker_not_initialized", "发布队列缺少应用锁，请先初始化数据库。", 503);
}
async function audit(db: AppDb, pub: Publication, type: string, summary: Record<string, unknown>, occurredAt: string, actor?: Actor) {
  await appendAudit(db, { workspaceId: pub.workspaceId, topicId: pub.topicId, actorId: actor?.id ?? null, actorMode: actor?.mode ?? "system", type, entityType: "publication", entityId: pub.id, payloadSummary: summary, occurredAt });
}

async function verifyApproval(db: AppDb, pub: Publication): Promise<void> {
  const [user] = await db.select().from(t.users).where(and(eq(t.users.workspaceId, pub.workspaceId), eq(t.users.id, pub.approvedById))).limit(1);
  const [workspace] = await db.select().from(t.workspaces).where(eq(t.workspaces.id, pub.workspaceId)).limit(1);
  if (!user || currentUserRole(user) !== "maintainer" || !workspace || workspace.kind === "preview" ||
    (workspace.kind === "demo" && (user.providerMode !== "replay" || pub.providerMode !== "replay")) ||
    (workspace.kind === "live" && (user.providerMode !== "live" || !user.providerSubject)) ||
    (pub.providerMode === "live" && (workspace.kind !== "live" || user.providerMode !== "live"))) {
    throw new DomainError("approval_identity_invalid", "发布确认者的身份或权限已失效。", 403);
  }
  const [probe] = await db.select().from(t.probes).where(and(eq(t.probes.workspaceId, pub.workspaceId), eq(t.probes.id, pub.probeId))).limit(1);
  const [topic] = await db.select().from(t.topics).where(and(eq(t.topics.workspaceId, pub.workspaceId), eq(t.topics.id, pub.topicId))).limit(1);
  if (!probe || !topic || probe.topicId !== topic.id || probe.status !== "approved" || probe.reviewerId !== user.id || !probe.approvedAt) {
    throw new DomainError("approval_state_changed", "下一问的审核状态已改变，请重新审阅。", 409);
  }
  if (topic.status !== "active" || probe.baseVersionId !== topic.currentVersionId || pub.immutablePayload.baseVersionId !== topic.currentVersionId) {
    throw new DomainError("stale_publication", "答案版本已经更新，原发布确认已失效。", 409);
  }
  const payload = pub.immutablePayload;
  if (!payload.text?.trim() || !["in_app", "zhihu_circle"].includes(payload.target) ||
    (payload.target === "zhihu_circle" && (!pub.targetCircleId || payload.circleId !== pub.targetCircleId || payload.title !== CIRCLE_PUBLICATION_TITLE)) ||
    (payload.target === "in_app" && Boolean(payload.circleId || pub.targetCircleId))) {
    throw new DomainError("publication_payload_invalid", "发布任务的内容或目标不完整。", 409);
  }
  const [consent] = await db.select().from(t.consents).where(and(eq(t.consents.workspaceId, pub.workspaceId), eq(t.consents.id, pub.approvalId))).limit(1);
  if (!consent || consent.userId !== user.id || consent.purpose !== `probe:${pub.probeId}` || !consent.confirmedAt || consent.revokedAt || !consent.expiresAt || !consent.preview) {
    throw new DomainError("publication_consent_invalid", "发布确认已撤销或尚未完成。", 403);
  }
  const confirmed = new Date(consent.confirmedAt).getTime(), expiry = new Date(consent.expiresAt).getTime();
  if (!Number.isFinite(confirmed) || !Number.isFinite(expiry) || confirmed > expiry) throw new DomainError("publication_consent_expired", "这次发布没有在预览有效期内完成确认。", 409);
  let preview: unknown;
  try { preview = JSON.parse(consent.preview); } catch { throw new DomainError("publication_preview_invalid", "发布预览记录无法校验。", 409); }
  const expectedHash = contentHash({ actorId: user.id, workspaceId: pub.workspaceId, probeId: pub.probeId, payload, expiresAt: new Date(consent.expiresAt).toISOString() });
  if (!equalHash(pub.previewHash, consent.payloadHash) || !equalHash(pub.previewHash, expectedHash) || contentHash(preview) !== contentHash(payload)) {
    throw new DomainError("publication_payload_changed", "发布正文与已确认预览不一致，未向外发送。", 409);
  }
  const sources = await db.select().from(t.evidence).where(and(eq(t.evidence.workspaceId, pub.workspaceId), eq(t.evidence.topicId, pub.topicId)));
  const versions = await db.select().from(t.claimVersions).where(and(eq(t.claimVersions.workspaceId, pub.workspaceId), eq(t.claimVersions.topicId, pub.topicId), eq(t.claimVersions.id, probe.baseVersionId)));
  const [targetCondition] = await db.select().from(t.conditions).where(and(eq(t.conditions.workspaceId, pub.workspaceId), eq(t.conditions.topicId, pub.topicId), eq(t.conditions.id, probe.targetUnknownId)));
  if (versions.length !== 1 || versions[0].status !== "published" || !targetCondition || publicationHasUnavailableSources(pub, { evidence: sources, versions, probes: [probe], conditions: [targetCondition] })) {
    throw new DomainError("publication_source_unavailable", "这条下一问引用或参考的贡献已不可用，请重新审阅。", 409);
  }
  const frozenIds = Array.isArray(payload.evidenceIds) ? payload.evidenceIds.filter((id): id is string => typeof id === "string") : [];
  const usedIds = [...frozenIds, ...probe.evidenceIds, ...probe.modelRun.inputEvidenceIds, ...versions[0].evidenceIds, ...versions[0].conditionsSnapshot.flatMap((condition) => condition.evidenceIds), ...targetCondition.evidenceIds];
  assertEvidenceReferences(usedIds, sources);
  const pendingReports = await db.select({ entityId: t.reports.entityId }).from(t.reports).where(and(eq(t.reports.workspaceId, pub.workspaceId), eq(t.reports.topicId, pub.topicId), eq(t.reports.status, "pending")));
  if (pendingReports.some((report) => report.entityId === probe.id || usedIds.includes(report.entityId))) throw new DomainError("publication_report_pending", "相关内容仍有待处理的举报，请先审阅。", 409);
}

async function failBeforeDelivery(db: AppDb, pub: Publication, error: unknown, now: string) {
  const message = error instanceof DomainError ? error.message : "发布确认校验失败，未向外发送。";
  const code = error instanceof DomainError ? error.code : "approval_verification_failed";
  await db.update(t.publications).set({ status: "permanently_failed", lastError: message, nextAttemptAt: null, leaseOwner: null, leaseUntil: null }).where(eq(t.publications.id, pub.id));
  await db.update(t.probes).set({ status: "expired", decisionReason: message }).where(and(eq(t.probes.id, pub.probeId), eq(t.probes.status, "approved")));
  await audit(db, pub, "publication.blocked", { status: "permanently_failed", errorCode: code }, now);
}

/** Recover queue state; an expired external live lease is never made pending again. */
async function recoverExpired(db: AppDb, clock: OutboxOptions): Promise<number> {
  return db.transaction(async (tx) => {
    const target = tx as unknown as AppDb;
    await lockAppQueue(target); const now = await databaseNow(target, clock);
    const expired = await tx.select().from(t.publications).where(and(publicationScope(clock), eq(t.publications.status, "sending"), or(isNull(t.publications.leaseUntil), lte(t.publications.leaseUntil, now.toISOString())))).for("update", { skipLocked: true });
    for (const pub of expired) {
      const uncertain = pub.providerMode === "live" && pub.immutablePayload.target === "zhihu_circle";
      await tx.update(t.publications).set({
        status: uncertain ? "needs_reconciliation" : "pending",
        // Keep the old owner for a late, verifiable success receipt from that same send.
        leaseOwner: uncertain ? pub.leaseOwner : null, leaseUntil: null,
        nextAttemptAt: null,
        lastError: uncertain ? "发送期间进程中断，知乎可能已收到内容。请先核对远端，不能自动重发。" : "本地任务已从中断状态恢复，等待继续处理。",
      }).where(eq(t.publications.id, pub.id));
      await audit(target, pub, uncertain ? "publication.delivery_uncertain" : "publication.lease_recovered", { status: uncertain ? "needs_reconciliation" : "pending", reasonCode: "lease_expired", providerMode: pub.providerMode }, now.toISOString());
    }
    return expired.length;
  });
}

type ClaimResult = { kind: "none" } | { kind: "blocked" } | { kind: "rate_limited" } | { kind: "claimed"; publication: Publication };
function publicationScope(options: OutboxOptions) {
  return options.scope ? and(eq(t.publications.workspaceId, options.scope.workspaceId), eq(t.publications.id, options.scope.publicationId)) : undefined;
}
async function claimNext(db: AppDb, options: OutboxOptions, workerId: string): Promise<ClaimResult> {
  const policy = getPublicationPolicy();
  return db.transaction(async (tx) => {
    const target = tx as unknown as AppDb; await lockAppQueue(target); const now = await databaseNow(target, options);
    const [pub] = await tx.select().from(t.publications).where(and(publicationScope(options), eq(t.publications.status, "pending"), or(isNull(t.publications.nextAttemptAt), lte(t.publications.nextAttemptAt, now.toISOString())))).orderBy(asc(t.publications.createdAt), asc(t.publications.id)).limit(1).for("update", { skipLocked: true });
    if (!pub) return { kind: "none" };
    try { await verifyApproval(target, pub); } catch (error) { await failBeforeDelivery(target, pub, error, now.toISOString()); return { kind: "blocked" }; }
    const externalLive = pub.providerMode === "live" && pub.immutablePayload.target === "zhihu_circle";
    if (externalLive) {
      // Events are append-only and survive all later status changes and explicit retries.
      const recent = await tx.select({ at: t.auditEvents.occurredAt }).from(t.auditEvents).where(and(eq(t.auditEvents.type, ATTEMPT_EVENT), gt(t.auditEvents.occurredAt, new Date(now.getTime() - policy.windowMs).toISOString()))).orderBy(asc(t.auditEvents.occurredAt));
      if (recent.length >= policy.limit) {
        const nextAttemptAt = new Date(new Date(recent[recent.length - policy.limit].at).getTime() + policy.windowMs).toISOString();
        await tx.update(t.publications).set({ nextAttemptAt, lastError: `应用每小时最多向知乎发送 ${policy.limit} 次，任务已排队等待可用名额。` }).where(eq(t.publications.id, pub.id));
        await audit(target, pub, "publication.rate_deferred", { status: "pending", reasonCode: "app_hourly_limit", target: "zhihu_circle" }, now.toISOString());
        return { kind: "rate_limited" };
      }
    }
    const [claimed] = await tx.update(t.publications).set({ status: "sending", attemptCount: pub.attemptCount + 1, leaseOwner: workerId, leaseUntil: new Date(now.getTime() + (options.leaseMs ?? LEASE_MS)).toISOString(), nextAttemptAt: null, lastError: null }).where(and(eq(t.publications.id, pub.id), eq(t.publications.status, "pending"))).returning();
    if (!claimed) return { kind: "none" };
    await audit(target, claimed, externalLive ? ATTEMPT_EVENT : "publication.local_attempted", { status: "sending", target: pub.immutablePayload.target, providerMode: pub.providerMode, attemptCount: claimed.attemptCount }, now.toISOString());
    return { kind: "claimed", publication: claimed };
  });
}

async function finalize(db: AppDb, pub: Publication, workerId: string, clock: Clock, receipt?: PublishReceipt, error?: unknown): Promise<"sent" | "failed" | "needs_reconciliation" | "lost_lease"> {
  return db.transaction(async (tx) => {
    const target = tx as unknown as AppDb;
    const [current] = await tx.select().from(t.publications).where(eq(t.publications.id, pub.id)).for("update");
    if (!current || current.leaseOwner !== workerId || !["sending", "needs_reconciliation"].includes(current.status)) return "lost_lease";
    const now = (await databaseNow(target, clock)).toISOString();
    if (receipt) {
      if (receipt.mode !== pub.providerMode) throw new DomainError("provider_mode_mismatch", "发布服务返回了不同模式的回执。", 502);
      // Verified late receipts may safely reconcile an expired lease; no second POST occurs.
      await tx.update(t.publications).set({ status: "sent", remoteId: receipt.remoteId, remoteUrl: receipt.mode === "live" ? receipt.url ?? null : null, sentAt: receipt.sentAt, leaseOwner: null, leaseUntil: null, nextAttemptAt: null, lastError: null }).where(eq(t.publications.id, pub.id));
      const changedProbes = await tx.update(t.probes).set({ status: "asked" }).where(and(eq(t.probes.workspaceId, pub.workspaceId), eq(t.probes.id, pub.probeId), eq(t.probes.status, "approved"))).returning({ id: t.probes.id });
      await audit(target, pub, current.status === "needs_reconciliation" ? "publication.reconciled_sent" : "publication.sent", { status: "sent", target: pub.immutablePayload.target, providerMode: pub.providerMode, attemptCount: current.attemptCount }, now);
      if (changedProbes.length) {
        await appendAudit(target, { workspaceId: pub.workspaceId, topicId: pub.topicId, actorMode: "system", type: "probe.asked", entityType: "probe", entityId: pub.probeId, payloadSummary: { target: pub.immutablePayload.target, providerMode: pub.providerMode }, occurredAt: now });
      } else {
        // A real receipt remains factual even if moderation changed the local probe in flight.
        await audit(target, pub, "publication.probe_state_changed", { status: "sent", reasonCode: "probe_changed_during_delivery" }, now);
      }
      return "sent";
    }
    if (current.status === "needs_reconciliation") return "needs_reconciliation";
    const externalLive = pub.providerMode === "live" && pub.immutablePayload.target === "zhihu_circle";
    const providerError = error instanceof ProviderError ? error : undefined;
    const uncertain = externalLive && (!providerError || providerError.kind === "unknown_delivery");
    const retryable = !uncertain && Boolean(providerError?.retryable);
    const status = uncertain ? "needs_reconciliation" : retryable ? "retryable_failed" : "permanently_failed";
    const message = uncertain ? "知乎发布结果未能确认。请先核对远端内容，不能直接重发。" : providerError?.message ?? "发布任务未完成，请检查服务端配置。";
    const nextAttemptAt = retryable && providerError?.retryAfterMs ? new Date(new Date(now).getTime() + providerError.retryAfterMs).toISOString() : null;
    await tx.update(t.publications).set({ status, nextAttemptAt, lastError: message, leaseOwner: null, leaseUntil: null }).where(eq(t.publications.id, pub.id));
    await audit(target, pub, uncertain ? "publication.delivery_uncertain" : "publication.failed", { status, errorCode: providerError?.kind ?? "unexpected_failure", attemptCount: current.attemptCount, providerMode: pub.providerMode }, now);
    return uncertain ? "needs_reconciliation" : "failed";
  });
}

export async function processOutbox(options: OutboxOptions = {}): Promise<OutboxResult> {
  const db = options.db ?? (await getDatabase()).db;
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (options.leaseMs !== undefined && (!Number.isFinite(options.leaseMs) || options.leaseMs < 1000)) || (options.scope && (!options.scope.workspaceId || !options.scope.publicationId))) throw new DomainError("worker_options_invalid", "发布队列的运行参数无效。", 400);
  const workerId = options.workerId ?? `worker:${randomUUID()}`;
  const result: OutboxResult = { processed: 0, sent: 0, failed: 0, needsReconciliation: 0, recovered: await recoverExpired(db, options), rateLimited: 0 };
  for (let index = 0; index < limit; index++) {
    const claim = await claimNext(db, options, workerId);
    if (claim.kind === "none") break;
    if (claim.kind === "blocked") { result.failed++; result.processed++; continue; }
    if (claim.kind === "rate_limited") { result.rateLimited++; continue; }
    const pub = claim.publication; result.processed++;
    let receipt: PublishReceipt | undefined, error: unknown;
    try {
      if (pub.immutablePayload.target === "in_app") {
        const now = (await databaseNow(db, options)).toISOString();
        receipt = { remoteId: `in-app:${pub.probeId}`, mode: pub.providerMode, sentAt: now, provenance: { provider: pub.providerMode === "replay" ? "replay" : "zhihu", mode: pub.providerMode, fetchedAt: now } };
      } else {
        const provider = options.providerFactory?.(pub.providerMode) ?? createZhihuProvider({ mode: pub.providerMode });
        if (provider.mode !== pub.providerMode) throw new ProviderError("unauthorized", "演示任务与真实发布服务不能混用。");
        const payload = { circleId: pub.targetCircleId!, text: pub.immutablePayload.text };
        receipt = publishReceiptSchema.parse(await provider.publishCircleQuestion({ ...payload, idempotencyKey: `${pub.workspaceId}:${pub.idempotencyKey}`, approvedPayloadHash: hashPublishPayload(payload) }));
        if (receipt.mode !== pub.providerMode) throw new ProviderError("unknown_delivery", "发布回执模式无法验证，请核对远端状态。");
      }
    } catch (cause) { receipt = undefined; error = cause; }
    // A database failure here leaves the lease intact: recovery treats external live delivery as unknown.
    const status = await finalize(db, pub, workerId, options, receipt, error);
    if (status === "sent") result.sent++; else if (status === "needs_reconciliation") result.needsReconciliation++; else if (status === "failed") result.failed++;
  }
  return result;
}

async function scopedPublication(db: AppDb, actor: Actor, id: string): Promise<Publication> {
  requireRole(actor);
  const [user] = await db.select().from(t.users).where(and(eq(t.users.id, actor.id), eq(t.users.workspaceId, actor.workspaceId))).limit(1);
  const [pub] = await db.select().from(t.publications).where(and(eq(t.publications.workspaceId, actor.workspaceId), eq(t.publications.id, id))).limit(1);
  if (!pub) throw new DomainError("not_found", "没有找到这条发布任务。", 404);
  if (!user || user.providerMode !== actor.mode || (currentUserRole(user) !== "maintainer" && pub.approvedById !== user.id)) throw new DomainError("forbidden", "你不能查看这条发布任务。", 403);
  return pub;
}
export async function getPublication(db: AppDb, actor: Actor, id: string) {
  const pub = await scopedPublication(db, actor, id);
  const [evidence, versions, probes, conditions] = await Promise.all([
    db.select().from(t.evidence).where(and(eq(t.evidence.workspaceId, pub.workspaceId), eq(t.evidence.topicId, pub.topicId))),
    db.select().from(t.claimVersions).where(and(eq(t.claimVersions.workspaceId, pub.workspaceId), eq(t.claimVersions.topicId, pub.topicId))),
    db.select().from(t.probes).where(and(eq(t.probes.workspaceId, pub.workspaceId), eq(t.probes.id, pub.probeId))),
    db.select().from(t.conditions).where(and(eq(t.conditions.workspaceId, pub.workspaceId), eq(t.conditions.topicId, pub.topicId))),
  ]);
  return publicPublication(pub, publicationHasUnavailableSources(pub, { evidence, versions, probes, conditions }));
}
export async function retryPublication(db: AppDb, actor: Actor, id: string) {
  requireRole(actor, "maintainer");
  await db.transaction(async (tx) => {
    const target = tx as unknown as AppDb; await lockAppQueue(target);
    const pub = await scopedPublication(target, actor, id);
    const [currentUser] = await tx.select().from(t.users).where(eq(t.users.id, actor.id));
    if (!currentUser || currentUserRole(currentUser) !== "maintainer") throw new DomainError("forbidden", "只有当前维护者可以重试发布。", 403);
    if (pub.status !== "retryable_failed") throw new DomainError("publication_not_retryable", pub.status === "needs_reconciliation" ? "发送结果尚未核对，不能直接重试。" : "这条任务当前不允许重试。", 409);
    const now = await databaseNow(target, {});
    if (pub.nextAttemptAt && new Date(pub.nextAttemptAt).getTime() > now.getTime()) throw new DomainError("publication_retry_delayed", "还未到允许重试的时间，请稍后再试。", 429);
    await verifyApproval(target, pub);
    const changed = await tx.update(t.publications).set({ status: "pending", nextAttemptAt: null, lastError: null, leaseOwner: null, leaseUntil: null }).where(and(eq(t.publications.id, pub.id), eq(t.publications.status, "retryable_failed"))).returning();
    if (changed.length !== 1) throw new DomainError("publication_state_changed", "发布状态已改变，请刷新后查看。", 409);
    await audit(target, pub, "publication.retry_requested", { status: "pending", attemptCount: pub.attemptCount }, now.toISOString(), actor);
  });
  return { publication: await getPublication(db, actor, id) };
}

export interface OutboxWorkerLoop { stop(): Promise<void> }
const workerGlobal = globalThis as typeof globalThis & { __liveAnswersOutboxLoop?: OutboxWorkerLoop };
/** Called by Next instrumentation or the dedicated PostgreSQL worker; no public HTTP endpoint. */
export function startOutboxWorkerLoop(options: OutboxOptions & { pollIntervalMs?: number; onError?: (message: string) => void } = {}): OutboxWorkerLoop {
  if (workerGlobal.__liveAnswersOutboxLoop) return workerGlobal.__liveAnswersOutboxLoop;
  const interval = Math.max(1000, options.pollIntervalMs ?? 15000); let stopped = false; let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = processOutbox(options).then(() => undefined).catch(() => { options.onError?.("发布队列暂时无法运行，将在下次检查时重试读取状态。"); }).finally(() => { running = undefined; });
  };
  const timer = setInterval(tick, interval); timer.unref();
  const loop = { stop: async () => { stopped = true; clearInterval(timer); await running; if (workerGlobal.__liveAnswersOutboxLoop === loop) delete workerGlobal.__liveAnswersOutboxLoop; } };
  workerGlobal.__liveAnswersOutboxLoop = loop; tick(); return loop;
}
