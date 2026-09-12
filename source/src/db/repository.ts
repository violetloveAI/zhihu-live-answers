import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { AppDb } from "./index";
import * as s from "./schema";
import { createDemoWorkspace as seedDemoWorkspace } from "./seed";
import { assertEvidenceReferences, assertRevisionBase, contentHash, DomainError, requireRole, safeAuditSummary } from "../domain/index";
import type { Actor, ConditionSnapshot } from "../domain/index";
export { teachingIds, teachingTopicSlugs } from "./seed";
import { publicEvidence, publicExperience, publicVersion, publicProbe, publicRevision, publicPublication, hasUnavailableSources, publicationHasUnavailableSources, deriveTopicStatus } from "./projections";
export { publicEvidence, publicExperience, publicVersion, publicProbe, publicRevision, publicPublication, hasUnavailableSources, publicationHasUnavailableSources, deriveTopicStatus } from "./projections";
export type { PrivacyContext, DataChannelStatus, AgentStatus, AgentState } from "./projections";

export async function createDemoWorkspace(db?:AppDb):Promise<string> { const target=db??(await import("./index")).getDatabase().then(h=>h.db);return seedDemoWorkspace(await target); }
const scoped=(table:{workspaceId:typeof s.topics.workspaceId},workspaceId:string)=>eq(table.workspaceId,workspaceId);
export async function getTopicRecord(db:AppDb,workspaceId:string,idOrSlug:string) {
 const [topic]=await db.select().from(s.topics).where(and(scoped(s.topics,workspaceId),or(eq(s.topics.id,idOrSlug),eq(s.topics.slug,idOrSlug)))).limit(1);
 if(!topic) throw new DomainError("not_found","没有找到这个议题。",404);
 return topic;
}
export async function listTopics(db:AppDb,workspaceId:string,template?:"learning"|"social") {
 const rows=await db.select({topic:s.topics,versionNumber:s.claimVersions.versionNumber}).from(s.topics).leftJoin(s.claimVersions,eq(s.topics.currentVersionId,s.claimVersions.id)).where(and(eq(s.topics.workspaceId,workspaceId),template?eq(s.topics.template,template):undefined)).orderBy(asc(s.topics.createdAt),asc(s.topics.slug));
 return rows.map(({topic:t,versionNumber})=>({id:t.id,slug:t.slug,title:t.title,summary:t.summary,template:t.template,currentVersionId:t.currentVersionId,currentVersionNumber:versionNumber??0,updatedAt:t.updatedAt}));
}
export async function getVersions(db:AppDb,workspaceId:string,idOrSlug:string) {
 const topic=await getTopicRecord(db,workspaceId,idOrSlug);
 const [versions,sources]=await Promise.all([db.select().from(s.claimVersions).where(and(eq(s.claimVersions.workspaceId,workspaceId),eq(s.claimVersions.topicId,topic.id),inArray(s.claimVersions.status,["published","superseded"]))).orderBy(desc(s.claimVersions.versionNumber)),db.select().from(s.evidence).where(and(eq(s.evidence.workspaceId,workspaceId),eq(s.evidence.topicId,topic.id)))]);
 return versions.map(v=>publicVersion(v,sources));
}
export async function getTopicDetail(db:AppDb,workspaceId:string,idOrSlug:string,actor:Actor|null=null) {
 if(actor&&actor.workspaceId!==workspaceId)throw new DomainError("forbidden","当前身份不能读取此工作区。",403);
 const topic=await getTopicRecord(db,workspaceId,idOrSlug);const topicId=topic.id;const maintainer=actor?.role==="maintainer";
 const [versions,conditions,evidence,experiences,matches,probes,revisions,publications,snapshots]=await Promise.all([
  db.select().from(s.claimVersions).where(and(eq(s.claimVersions.workspaceId,workspaceId),eq(s.claimVersions.topicId,topicId))).orderBy(desc(s.claimVersions.versionNumber)),
  db.select().from(s.conditions).where(and(eq(s.conditions.workspaceId,workspaceId),eq(s.conditions.topicId,topicId))),
  db.select().from(s.evidence).where(and(eq(s.evidence.workspaceId,workspaceId),eq(s.evidence.topicId,topicId))).orderBy(asc(s.evidence.createdAt)),
  db.select().from(s.experiences).where(and(eq(s.experiences.workspaceId,workspaceId),eq(s.experiences.topicId,topicId))).orderBy(desc(s.experiences.createdAt)),
  db.select({match:s.matches,experienceId:s.experiences.id}).from(s.matches).innerJoin(s.experiences,eq(s.matches.experienceId,s.experiences.id)).where(and(eq(s.matches.workspaceId,workspaceId),eq(s.experiences.topicId,topicId))),
  db.select().from(s.probes).where(and(eq(s.probes.workspaceId,workspaceId),eq(s.probes.topicId,topicId))).orderBy(desc(s.probes.createdAt)),
  db.select().from(s.revisions).where(and(eq(s.revisions.workspaceId,workspaceId),eq(s.revisions.topicId,topicId))).orderBy(desc(s.revisions.createdAt)),
  db.select().from(s.publications).where(and(eq(s.publications.workspaceId,workspaceId),eq(s.publications.topicId,topicId))).orderBy(desc(s.publications.createdAt)),
  db.select().from(s.sourceSnapshots).where(and(eq(s.sourceSnapshots.workspaceId,workspaceId),eq(s.sourceSnapshots.topicId,topicId))).orderBy(desc(s.sourceSnapshots.fetchedAt)),
 ]);
 const privacy={evidence,versions,conditions,probes};
 const visibleProbes=probes.filter(p=>maintainer||["asked","answered"].includes(p.status));
 const visibleRevisions=revisions.filter(r=>maintainer||["accepted","rejected","deferred"].includes(r.status));
 const modelRuns=[...probes.map(p=>p.modelRun),...revisions.map(r=>r.modelRun),...matches.map(m=>m.match.modelRun)];
 const {dataStatus,agent}=deriveTopicStatus({snapshots,experiences,modelRuns,probes,revisions,publications,versions,evidence,maintainer});
 return {
  topic:{id:topic.id,slug:topic.slug,title:topic.title,template:topic.template,summary:topic.summary,currentVersionId:topic.currentVersionId,circleId:topic.circleId,status:topic.status,createdAt:topic.createdAt,updatedAt:topic.updatedAt},
  currentVersion:versions.find(v=>v.id===topic.currentVersionId&&v.status==="published")?publicVersion(versions.find(v=>v.id===topic.currentVersionId&&v.status==="published")!,evidence):null,
  conditions:conditions.filter(c=>c.status==="active").map(({id,label,description,kind,evidenceIds,status})=>{const hidden=hasUnavailableSources(evidenceIds,privacy);return {id,label:hidden?"来源暂不可用":label,description:hidden?"引用的贡献已撤回或正在审核。":description,kind,evidenceIds,status:hidden?"unavailable":status};}),
  evidence:evidence.map(publicEvidence),
  experiences:experiences.map(e=>{
   const experienceMatches=matches.filter(m=>m.experienceId===e.id);
   const ownSourceHidden=evidence.some(source=>source.experienceId===e.id&&source.visibility!=="public");
   const hidden=ownSourceHidden||experienceMatches.some(({match:m})=>hasUnavailableSources([...m.evidenceIds,...m.modelRun.inputEvidenceIds],privacy));
   const reply=probes.find(p=>p.id===e.replyToProbeId),replyPublic=reply?publicProbe(reply,privacy):null;
   return {...publicExperience(e,actor?.id,hidden,replyPublic&&!replyPublic.hasUnavailableEvidence?replyPublic.question:null,ownSourceHidden),matches:e.withdrawnAt||e.deletedAt||hidden?[]:experienceMatches.map(({match:m})=>({id:m.id,conditionIds:m.conditionIds,evidenceIds:m.evidenceIds,relation:m.relation,reasons:m.reasons,confidence:m.confidence,modelRun:m.modelRun}))};
  }),
  probes:visibleProbes.map(p=>publicProbe(p,privacy)),
  revisions:visibleRevisions.map(r=>publicRevision(r,privacy)),
  publications:publications.filter(p=>maintainer||p.status==="sent").map(p=>publicPublication(p,publicationHasUnavailableSources(p,privacy))),
  versions:versions.filter(v=>v.status!=="draft").map(v=>publicVersion(v,evidence)),agent,dataStatus,
 };
}
export async function appendAudit(db:AppDb,event:Omit<typeof s.auditEvents.$inferInsert,"id"|"payloadSummary">&{payloadSummary?:Record<string,unknown>}) {
 const [row]=await db.insert(s.auditEvents).values({...event,payloadSummary:safeAuditSummary(event.payloadSummary??{})}).returning();return row;
}
export async function getAudit(db:AppDb,workspaceId:string,topicId:string) {
 return db.select({id:s.auditEvents.id,type:s.auditEvents.type,entityType:s.auditEvents.entityType,entityId:s.auditEvents.entityId,payloadSummary:s.auditEvents.payloadSummary,occurredAt:s.auditEvents.occurredAt,actorMode:s.auditEvents.actorMode}).from(s.auditEvents).where(and(eq(s.auditEvents.workspaceId,workspaceId),eq(s.auditEvents.topicId,topicId))).orderBy(desc(s.auditEvents.occurredAt));
}
export async function withIdempotency<T>(db:AppDb,actor:Actor,route:string,key:string,payload:unknown,fn:(tx:AppDb)=>Promise<T>):Promise<{data:T;replayed:boolean}> {
 if(!key||key.length>200)throw new DomainError("idempotency_key_required","请提供有效的 Idempotency-Key。",400);
 return db.transaction(async tx=>{
  // Row lock serializes a user's retries while the unique constraint is the final guard.
  await tx.select({id:s.users.id}).from(s.users).where(and(eq(s.users.id,actor.id),eq(s.users.workspaceId,actor.workspaceId))).for("update");
  const [existing]=await tx.select().from(s.idempotencyRecords).where(and(eq(s.idempotencyRecords.workspaceId,actor.workspaceId),eq(s.idempotencyRecords.actorId,actor.id),eq(s.idempotencyRecords.route,route),eq(s.idempotencyRecords.key,key)));
  const hash=contentHash(payload);
  if(existing) {if(existing.payloadHash!==hash)throw new DomainError("idempotency_conflict","同一请求编号对应的内容已经改变，请重新确认。",409);return {data:existing.response as T,replayed:true};}
  const data=await fn(tx as unknown as AppDb);
  await tx.insert(s.idempotencyRecords).values({workspaceId:actor.workspaceId,actorId:actor.id,route,key,payloadHash:hash,response:data});
  return {data,replayed:false};
 });
}
export async function acceptRevisionInTransaction(tx:AppDb,actor:Actor,revisionId:string,expectedBaseVersionId:string) {
 requireRole(actor,"maintainer");
  const [revision]=await tx.select().from(s.revisions).where(and(eq(s.revisions.workspaceId,actor.workspaceId),eq(s.revisions.id,revisionId))).for("update");
  if(!revision)throw new DomainError("not_found","没有找到这条修订。",404);
  const [topic]=await tx.select().from(s.topics).where(and(eq(s.topics.workspaceId,actor.workspaceId),eq(s.topics.id,revision.topicId))).for("update");
  if(revision.status==="accepted") {const [version]=await tx.select().from(s.claimVersions).where(eq(s.claimVersions.id,revision.acceptedVersionId!));return {revision,currentVersion:version};}
  if(!["proposed","deferred"].includes(revision.status))throw new DomainError("invalid_revision_state","这条修订还不能接受。",409);
  assertRevisionBase(expectedBaseVersionId,topic.currentVersionId);assertRevisionBase(revision.baseVersionId,topic.currentVersionId);
  const sources=await tx.select().from(s.evidence).where(and(eq(s.evidence.workspaceId,actor.workspaceId),eq(s.evidence.topicId,topic.id)));
  assertEvidenceReferences(revision.evidenceIds,sources);
  for(const c of revision.proposedConditions)assertEvidenceReferences(c.evidenceIds,sources);
  const pendingReports=await tx.select().from(s.reports).where(and(eq(s.reports.workspaceId,actor.workspaceId),eq(s.reports.topicId,topic.id),eq(s.reports.status,"pending")));
  if(pendingReports.some(r=>r.entityId===revision.id||revision.evidenceIds.includes(r.entityId)))throw new DomainError("reported_evidence","相关举报尚待审核，暂不能发布新结论。",409);
  const [base]=await tx.select().from(s.claimVersions).where(eq(s.claimVersions.id,revision.baseVersionId));
  const versionId=randomUUID();const now=new Date().toISOString();
  await tx.update(s.claimVersions).set({status:"superseded"}).where(eq(s.claimVersions.id,base.id));
  const contributorNames=Array.from(new Set(sources.filter(e=>revision.evidenceIds.includes(e.id)).map(e=>e.displayAuthor)));
  const proposedIds=revision.proposedConditions.flatMap(c=>c.id?[c.id]:[]);
  const referencedConditions=proposedIds.length?await tx.select().from(s.conditions).where(inArray(s.conditions.id,proposedIds)):[];
  if(referencedConditions.some(c=>c.workspaceId!==actor.workspaceId||c.topicId!==topic.id))throw new DomainError("invalid_condition","修订引用的条件不属于这个议题。",422);
  const nextConditions:ConditionSnapshot[]=revision.proposedConditions.map(c=>({...c,id:c.id??randomUUID(),kind:c.kind??"context",description:c.description??c.label,status:c.status??"active"}));
  const [version]=await tx.insert(s.claimVersions).values({id:versionId,workspaceId:actor.workspaceId,topicId:topic.id,versionNumber:base.versionNumber+1,baseVersionId:base.id,text:revision.proposedText,conditionsSnapshot:nextConditions,evidenceIds:Array.from(new Set([...base.evidenceIds,...revision.evidenceIds])).filter(id=>sources.some(e=>e.id===id&&e.visibility==="public")),contributorDisplaySnapshot:Array.from(new Set([...base.contributorDisplaySnapshot,...contributorNames])),reviewerId:actor.id,publishedAt:now,status:"published"}).returning();
  const changed=await tx.update(s.topics).set({currentVersionId:versionId,updatedAt:now}).where(and(eq(s.topics.id,topic.id),eq(s.topics.currentVersionId,base.id))).returning();
  if(!changed.length)throw new DomainError("stale_version","答案已经更新，请重新审阅。",409);
  await tx.update(s.conditions).set({status:"superseded"}).where(and(eq(s.conditions.workspaceId,actor.workspaceId),eq(s.conditions.topicId,topic.id)));
  for(const c of nextConditions){const changed=await tx.insert(s.conditions).values({id:c.id!,workspaceId:actor.workspaceId,topicId:topic.id,label:c.label,description:c.description!,kind:c.kind!,evidenceIds:c.evidenceIds,status:c.status!}).onConflictDoUpdate({target:s.conditions.id,set:{label:c.label,description:c.description!,kind:c.kind!,evidenceIds:c.evidenceIds,status:c.status!},setWhere:and(eq(s.conditions.workspaceId,actor.workspaceId),eq(s.conditions.topicId,topic.id))}).returning({id:s.conditions.id});if(!changed.length)throw new DomainError("invalid_condition","条件已经变更，请重新审阅。",409);}
  const [accepted]=await tx.update(s.revisions).set({status:"accepted",reviewerId:actor.id,decidedAt:now,acceptedVersionId:versionId}).where(eq(s.revisions.id,revision.id)).returning();
  await appendAudit(tx as unknown as AppDb,{workspaceId:actor.workspaceId,topicId:topic.id,actorId:actor.id,actorMode:actor.mode,type:"revision.accepted",entityType:"revision",entityId:revision.id,payloadSummary:{baseVersionId:base.id,newVersionId:versionId,versionNumber:version.versionNumber,evidenceCount:revision.evidenceIds.length}});
  return {revision:accepted,currentVersion:version};
}
export async function acceptRevision(db:AppDb,actor:Actor,revisionId:string,expectedBaseVersionId:string) {
 return db.transaction(tx=>acceptRevisionInTransaction(tx as unknown as AppDb,actor,revisionId,expectedBaseVersionId));
}
export type TopicDetail = Awaited<ReturnType<typeof getTopicDetail>>;
export type TopicSummary = Awaited<ReturnType<typeof listTopics>>[number];
export type ClaimVersionPublic = ReturnType<typeof publicVersion>;
export type ExperiencePublic = ReturnType<typeof publicExperience>;
export type PublicationPublic = ReturnType<typeof publicPublication>;
