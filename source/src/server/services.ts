import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, desc, sql } from "drizzle-orm";
import type { z } from "zod";
import type { AppDb } from "@/db";
import * as t from "@/db/schema";
import { getTopicRecord, withIdempotency, acceptRevisionInTransaction } from "@/db/repository";
import { DomainError, contentHash, makeExperiencePreview, displayIdentity, assertEvidenceReferences, assertRevisionBase, redactPII, requireRole, safeAuditSummary, type Actor, type experiencePreviewSchema, type experienceSubmitSchema, type probePreviewSchema, type probeApproveSchema, type revisionDecisionSchema } from "@/domain";
import { CIRCLE_PUBLICATION_TITLE, createZhihuProvider } from "@/providers/zhihu";
import { createLLMProvider } from "@/providers/llm";
import { ProviderError, type LLMProvider, type ZhihuProvider, type SourceItem } from "@/providers/contracts";
import { getPublicationPolicy } from "./publication-policy";

const now=()=>new Date().toISOString();
const scope=(actor:Actor,table:{workspaceId:typeof t.topics.workspaceId})=>eq(table.workspaceId,actor.workspaceId);
function publicExperience(row:typeof t.experiences.$inferSelect) {
  const {rawText:_,ownerId:__,consentId:___,workspaceId:____,...rest}=row;
  return rest;
}
export async function audit(db:AppDb,actor:Actor,topicId:string|null,type:string,entityType:string,entityId:string,payload:Record<string,unknown>={}) {
  await db.insert(t.auditEvents).values({workspaceId:actor.workspaceId,topicId,actorId:actor.id,actorMode:actor.mode,type,entityType,entityId,payloadSummary:safeAuditSummary(payload)});
}
export class AnswerService {
  constructor(readonly db:AppDb, readonly actor:Actor, readonly zhihu:ZhihuProvider=createZhihuProvider({mode:actor.mode==='replay'?'replay':undefined}), readonly llm:LLMProvider=createLLMProvider({mode:actor.mode==='replay'?'replay':undefined})) {}
  private async modelStatus(topicId:string,status:'loading'|'ready'|'failed',operation:string,entityId?:string,error?:string) { await this.db.insert(t.sourceSnapshots).values({workspaceId:this.actor.workspaceId,topicId,provider:'llm',mode:this.llm.mode,payload:{status,operation,entityId},fetchedAt:now(),lastError:error}); }
  private async topic(id:string) { const topic=await getTopicRecord(this.db,this.actor.workspaceId,id); if(!topic)throw new DomainError('topic_not_found','这个议题暂时找不到了。',404);return topic; }
  private async sourceRows(topicId:string) { return this.db.select().from(t.evidence).where(and(eq(t.evidence.workspaceId,this.actor.workspaceId),eq(t.evidence.topicId,topicId),eq(t.evidence.visibility,'public'))); }
  private async version(topicId:string,versionId:string|null) { if(!versionId)throw new DomainError('no_current_version','这个议题还没有公开答案，请先补充证据。',409);const [v]=await this.db.select().from(t.claimVersions).where(and(eq(t.claimVersions.id,versionId),eq(t.claimVersions.workspaceId,this.actor.workspaceId),eq(t.claimVersions.topicId,topicId)));if(!v)throw new DomainError('no_current_version','当前版本不存在。',409);return v; }
  private async contributionTarget(db:AppDb,topicId:string,replyToProbeId?:string) {
    if(!replyToProbeId)return null;
    const [probe]=await db.select().from(t.probes).where(and(eq(t.probes.workspaceId,this.actor.workspaceId),eq(t.probes.topicId,topicId),eq(t.probes.id,replyToProbeId),inArray(t.probes.status,['asked','answered']))).limit(1);
    if(!probe)throw new DomainError('reply_target_unavailable','只能回复当前议题中已经发出的下一问。',409);
    const evidence=await db.select().from(t.evidence).where(and(eq(t.evidence.workspaceId,this.actor.workspaceId),eq(t.evidence.topicId,topicId),eq(t.evidence.visibility,'public')));
    assertEvidenceReferences(probe.evidenceIds,evidence);
    return probe;
  }
  async previewExperience(topicId:string,input:z.infer<typeof experiencePreviewSchema>) {
    requireRole(this.actor);const topic=await this.topic(topicId);
    const reply=await this.contributionTarget(this.db,topic.id,input.replyToProbeId);
    const preview=makeExperiencePreview(input,this.actor,new Date(Date.now()+15*60_000).toISOString());
    await this.db.insert(t.consents).values({workspaceId:this.actor.workspaceId,userId:this.actor.id,purpose:`experience:${topic.id}`,displayMode:input.displayMode,payloadHash:preview.previewHash,preview:JSON.stringify({publicText:preview.publicText,displayIdentity:preview.displayIdentity,contributionKind:preview.contributionKind,replyToProbeId:preview.replyToProbeId,sourceUrl:preview.sourceUrl,displayAvatarUrl:preview.displayAvatarUrl}),expiresAt:preview.expiresAt});
    return {...preview,replyToProbeQuestion:reply?.question??null,sourceVerification:preview.sourceUrl?'user_provided_unverified' as const:null};
  }
  async submitExperience(topicId:string,input:z.infer<typeof experienceSubmitSchema>,key:string) {
    requireRole(this.actor);const topic=await this.topic(topicId);
    const saved=await withIdempotency(this.db,this.actor,`experience:${topic.id}`,key,input,async db=>{
      const [consent]=await db.select().from(t.consents).where(and(eq(t.consents.workspaceId,this.actor.workspaceId),eq(t.consents.userId,this.actor.id),eq(t.consents.payloadHash,input.previewHash),eq(t.consents.purpose,`experience:${topic.id}`))).limit(1);
      if(!consent?.expiresAt || new Date(consent.expiresAt).getTime()<Date.now() || consent.revokedAt || consent.confirmedAt)throw new DomainError('preview_expired','预览已过期，请重新检查公开内容。',409);
      const preview=makeExperiencePreview({text:input.text,displayMode:input.displayMode,pseudonym:input.pseudonym,contributionKind:input.contributionKind,replyToProbeId:input.replyToProbeId,sourceUrl:input.sourceUrl},this.actor,new Date(consent.expiresAt).toISOString());
      if(preview.previewHash!==input.previewHash || preview.publicText!==input.publicText)throw new DomainError('preview_changed','提交内容与刚才确认的预览不同，请重新预览。',409);
      await this.contributionTarget(db,topic.id,preview.replyToProbeId??undefined);
      const [experience]=await db.insert(t.experiences).values({workspaceId:this.actor.workspaceId,topicId:topic.id,ownerId:this.actor.id,rawText:input.text,publicText:preview.publicText,displayMode:input.displayMode,displayName:preview.displayIdentity,displayAvatarUrl:preview.displayAvatarUrl,contributionKind:preview.contributionKind,replyToProbeId:preview.replyToProbeId,sourceUrl:preview.sourceUrl,consentId:consent.id}).returning();
      await db.update(t.consents).set({confirmedAt:now()}).where(eq(t.consents.id,consent.id));
      await db.insert(t.evidence).values({workspaceId:this.actor.workspaceId,topicId:topic.id,sourceType:'experience',provider:'experience',sourceId:experience.id,url:preview.sourceUrl,title:preview.contributionKind==='evidence'?'用户提供的参考链接（未经平台验证）':preview.contributionKind==='comment'?'一条新的讨论补充':'一份新的亲身经历',summary:experience.publicText,displayAuthor:experience.displayName,fetchedAt:now(),contentHash:contentHash({text:experience.publicText,sourceUrl:preview.sourceUrl}),experienceId:experience.id,provenance:{provider:'experience',mode:this.actor.mode,fetchedAt:now(),...(preview.sourceUrl?{sourceNature:'user_provided' as const}:{})}});
      if(preview.replyToProbeId)await db.update(t.probes).set({status:'answered'}).where(and(eq(t.probes.id,preview.replyToProbeId),eq(t.probes.workspaceId,this.actor.workspaceId),eq(t.probes.status,'asked')));
      await audit(db,this.actor,topic.id,'experience.submitted','experience',experience.id,{displayMode:input.displayMode,providerMode:this.actor.mode,contributionKind:preview.contributionKind});
      return {experienceId:experience.id};
    });
    if(!saved.replayed)await this.analyzeExperience(saved.data.experienceId);
    const [experience]=await this.db.select().from(t.experiences).where(and(eq(t.experiences.id,saved.data.experienceId),eq(t.experiences.workspaceId,this.actor.workspaceId)));
    const matches=await this.db.select().from(t.matches).where(and(eq(t.matches.workspaceId,this.actor.workspaceId),eq(t.matches.experienceId,experience.id)));
    return {experience:publicExperience(experience),matches:matches.map(({workspaceId:_,...m})=>m),analysisStatus:experience.analysisStatus};
  }
  async analyzeExperience(id:string) {
    requireRole(this.actor);
    const [row]=await this.db.select().from(t.experiences).where(and(eq(t.experiences.id,id),eq(t.experiences.workspaceId,this.actor.workspaceId),isNull(t.experiences.withdrawnAt),isNull(t.experiences.deletedAt)));
    if(!row)throw new DomainError('experience_not_found','找不到这份经历，可能已经撤回。',404);
    if(row.ownerId!==this.actor.id&&this.actor.role!=='maintainer')throw new DomainError('forbidden','你只能重新整理自己的经历。',403);
    const runId=randomUUID();
    const latestRun=async(db:AppDb)=>{
      const [run]=await db.select().from(t.sourceSnapshots).where(and(eq(t.sourceSnapshots.workspaceId,this.actor.workspaceId),eq(t.sourceSnapshots.topicId,row.topicId),eq(t.sourceSnapshots.provider,'llm'),sql`${t.sourceSnapshots.payload}->>'operation' = 'analysis'`,sql`${t.sourceSnapshots.payload}->>'entityId' = ${id}`,sql`${t.sourceSnapshots.payload}->>'status' = 'loading'`)).orderBy(desc(t.sourceSnapshots.createdAt)).limit(1);
      return run;
    };
    const claimed=await this.db.transaction(async tx=>{
      const db=tx as unknown as AppDb;
      const [current]=await db.select().from(t.experiences).where(and(eq(t.experiences.id,id),eq(t.experiences.workspaceId,this.actor.workspaceId))).for('update');
      if(!current||current.withdrawnAt||current.deletedAt)return null;
      if(current.analysisStatus==='processing'){
        const active=await latestRun(db);
        if(active&&new Date(active.fetchedAt).getTime()>Date.now()-120_000)return null;
      }
      await db.update(t.experiences).set({analysisStatus:'processing',analysisError:null}).where(eq(t.experiences.id,id));
      await db.insert(t.sourceSnapshots).values({id:runId,workspaceId:this.actor.workspaceId,topicId:row.topicId,provider:'llm',mode:this.llm.mode,payload:{status:'loading',operation:'analysis',entityId:id},fetchedAt:now()});
      return current;
    });
    if(!claimed)return {analysisStatus:'processing'};
    const topic=await this.topic(row.topicId), evidence=await this.sourceRows(topic.id);
    const conditions=await this.db.select().from(t.conditions).where(and(eq(t.conditions.workspaceId,this.actor.workspaceId),eq(t.conditions.topicId,topic.id),eq(t.conditions.status,'active')));
    try {
      const result=await this.llm.analyzeEvidence({topic:{id:topic.id,title:topic.title},experience:{id:row.id,publicText:row.publicText},conditions:conditions.map(c=>({id:c.id,label:c.label})),evidence:evidence.map(e=>({id:e.id,summary:e.summary}))});
      const applied=await this.db.transaction(async tx=>{
        const [current]=await tx.select().from(t.experiences).where(and(eq(t.experiences.id,id),eq(t.experiences.workspaceId,this.actor.workspaceId))).for('update');
        if(!current || current.withdrawnAt || current.deletedAt || current.analysisStatus!=='processing' || (await latestRun(tx as unknown as AppDb))?.id!==runId)return false;
        const available=await tx.select().from(t.evidence).where(and(eq(t.evidence.workspaceId,this.actor.workspaceId),eq(t.evidence.topicId,topic.id),eq(t.evidence.visibility,'public')));
        for(const match of result.matches)assertEvidenceReferences(match.evidenceIds,available);
        await tx.delete(t.matches).where(and(eq(t.matches.workspaceId,this.actor.workspaceId),eq(t.matches.experienceId,id)));
        if(result.matches.length)await tx.insert(t.matches).values(result.matches.map(m=>({...m,workspaceId:this.actor.workspaceId,experienceId:id,modelRun:result.modelRun})));
        await tx.update(t.experiences).set({analysisStatus:result.status,extractedConditions:result.extractedConditions,caveats:result.caveats,analysisError:null}).where(eq(t.experiences.id,id));
        await audit(tx as unknown as AppDb,this.actor,topic.id,'experience.analyzed','experience',id,{status:result.status,providerMode:result.modelRun.mode});
        return true;
      });
      if(applied)await this.modelStatus(topic.id,'ready','analysis',id);
      return applied?result:{analysisStatus:'unavailable'};
    } catch(error) {
      const message=error instanceof ProviderError?error.message:'整理暂时没有完成，请稍后重试。';
      const applied=await this.db.transaction(async tx=>{
        const db=tx as unknown as AppDb;
        const [current]=await db.select().from(t.experiences).where(and(eq(t.experiences.id,id),eq(t.experiences.workspaceId,this.actor.workspaceId))).for('update');
        if(!current||current.withdrawnAt||current.deletedAt||current.analysisStatus!=='processing'||(await latestRun(db))?.id!==runId)return false;
        await db.update(t.experiences).set({analysisStatus:'failed',analysisError:message}).where(eq(t.experiences.id,id));return true;
      });
      if(applied)await this.modelStatus(topic.id,'failed','analysis',id,message);
      return {analysisStatus:'failed',error:message};
    }
  }
  async removeExperience(id:string,remove:boolean) {
    requireRole(this.actor);
    return this.db.transaction(async tx=>{
      const [row]=await tx.select().from(t.experiences).where(and(eq(t.experiences.id,id),eq(t.experiences.workspaceId,this.actor.workspaceId))).for('update');
      if(!row)throw new DomainError('not_found','没有找到这份经历。',404);
      if(row.ownerId!==this.actor.id)throw new DomainError('forbidden','只有经历的贡献者可以撤回或删除。',403);
      await tx.update(t.experiences).set({rawText:remove?null:row.rawText,publicText:'[这份经历已撤回]',displayName:'已撤回的知友',sourceUrl:null,displayAvatarUrl:null,withdrawnAt:row.withdrawnAt??now(),deletedAt:remove?now():row.deletedAt,extractedConditions:[],caveats:[],analysisStatus:'needs_review',analysisError:null}).where(eq(t.experiences.id,id));
      await tx.update(t.evidence).set({summary:'[来源已撤回]',displayAuthor:'已撤回的知友',visibility:'unavailable'}).where(and(eq(t.evidence.workspaceId,this.actor.workspaceId),eq(t.evidence.experienceId,id)));
      await tx.delete(t.matches).where(and(eq(t.matches.workspaceId,this.actor.workspaceId),eq(t.matches.experienceId,id)));
      await tx.update(t.consents).set({revokedAt:now(),preview:null}).where(eq(t.consents.id,row.consentId));
      await audit(tx as unknown as AppDb,this.actor,row.topicId,remove?'experience.deleted':'experience.withdrawn','experience',id);
      return {id,status:remove?'deleted':'withdrawn'};
    });
  }
  async ingest(topicId:string,source:'search'|'circle'|'all',query?:string) {
    requireRole(this.actor,'maintainer');const topic=await this.topic(topicId);
    let duplicates=0;const errors:string[]=[],addedEvidenceIds:string[]=[];let revision:typeof t.revisions.$inferSelect|undefined;
    for(const current of source==='all'?['search','circle'] as const:[source]) {
      // Persist the in-flight attempt before network I/O so other readers can show
      // searching while retaining the last successful snapshot and its timestamp.
      const [attempt]=await this.db.insert(t.sourceSnapshots).values({workspaceId:this.actor.workspaceId,topicId:topic.id,provider:current,mode:this.zhihu.mode,payload:{status:'loading'},fetchedAt:now()}).returning({id:t.sourceSnapshots.id});
      try {
        if(current==='circle'&&!topic.circleId)throw new ProviderError('unconfigured','这个议题还没有连接知乎圈子。');
        const snapshot=current==='search'?await this.zhihu.searchTopics({query:query??topic.title,limit:10}):await this.zhihu.listCircleDiscussion({circleId:topic.circleId!});
        const result=await this.ingestItems(topic.id,snapshot.items,current);addedEvidenceIds.push(...result.addedIds);duplicates+=result.duplicates;
        await this.db.update(t.sourceSnapshots).set({mode:snapshot.provenance.mode,payload:{itemCount:snapshot.items.length,status:'ready'},fetchedAt:snapshot.provenance.fetchedAt,lastError:null}).where(eq(t.sourceSnapshots.id,attempt.id));
        if(current==='circle'&&result.addedIds.length){
          await audit(this.db,this.actor,topic.id,'discussion.reply_ingested','topic',topic.id,{evidenceCount:result.addedIds.length,providerMode:snapshot.provenance.mode});
          await this.db.update(t.probes).set({status:'answered'}).where(and(eq(t.probes.workspaceId,this.actor.workspaceId),eq(t.probes.topicId,topic.id),eq(t.probes.status,'asked')));
          try { revision=(await this.proposeRevision(topic.id,result.addedIds)).revision; }
          catch { errors.push('新回复已保存，修订暂未整理完成，可以根据这些证据重新生成修订。'); }
        }
      }catch(error){
        const message=error instanceof ProviderError?error.message:'来源暂时无法更新。';errors.push(message);
        await this.db.update(t.sourceSnapshots).set({payload:{status:'failed'},fetchedAt:now(),lastError:message}).where(eq(t.sourceSnapshots.id,attempt.id));
      }
    }
    await audit(this.db,this.actor,topic.id,'source.refreshed','topic',topic.id,{source,evidenceCount:addedEvidenceIds.length,status:errors.length?'partial':'ready',providerMode:this.zhihu.mode});
    return {addedEvidenceCount:addedEvidenceIds.length,addedEvidenceIds,duplicateCount:duplicates,errors,providerMode:this.zhihu.mode,revision};
  }
  async ingestItems(topicId:string,items:SourceItem[],source:'search'|'circle') {
    let duplicates=0;const addedIds:string[]=[];
    for(const item of items){
      const inserted=await this.db.insert(t.evidence).values({workspaceId:this.actor.workspaceId,topicId,sourceType:item.provenance.mode==='replay'?'replay':source,provider:item.provenance.provider,sourceId:item.sourceId,url:item.url,title:item.title,summary:item.summary,displayAuthor:item.author?.displayName??'来源未提供作者',fetchedAt:item.provenance.fetchedAt,contentHash:contentHash(item.summary),provenance:item.provenance}).onConflictDoNothing().returning({id:t.evidence.id});
      if(inserted.length)addedIds.push(inserted[0].id);else duplicates++;
    }
    return {added:addedIds.length,addedIds,duplicates};
  }
  async proposeProbe(topicId:string) {
    requireRole(this.actor,'maintainer');const topic=await this.topic(topicId);const version=await this.version(topic.id,topic.currentVersionId);
    const unknowns=await this.db.select().from(t.conditions).where(and(eq(t.conditions.workspaceId,this.actor.workspaceId),eq(t.conditions.topicId,topic.id),eq(t.conditions.kind,'unknown'),eq(t.conditions.status,'active')));
    if(!unknowns.length)throw new DomainError('no_unknowns','目前没有标记为待验证的条件，先补充新的证据吧。',409);
    const evidence=await this.sourceRows(topic.id);
    await this.modelStatus(topic.id,'loading','probe');
    try {
      const proposal=await this.llm.proposeProbe({topicId:topic.id,baseVersionId:version.id,unknowns:unknowns.map(c=>({id:c.id,label:c.label})),evidence:evidence.map(e=>({id:e.id,summary:e.summary}))});
      const [probe]=await this.db.insert(t.probes).values({...proposal,workspaceId:this.actor.workspaceId,topicId:topic.id,baseVersionId:version.id}).returning();
      await audit(this.db,this.actor,topic.id,'probe.proposed','probe',probe.id,{status:probe.status,providerMode:proposal.modelRun.mode});
      await this.modelStatus(topic.id,'ready','probe',probe.id);
      return {probe};
    } catch(error) { await this.modelStatus(topic.id,'failed','probe',undefined,'下一问暂未整理完成，请稍后重试。');throw error; }
  }
  private async probe(id:string) {const [row]=await this.db.select().from(t.probes).where(and(eq(t.probes.workspaceId,this.actor.workspaceId),eq(t.probes.id,id)));if(!row)throw new DomainError('probe_not_found','没有找到这条下一问。',404);return row;}
  async previewProbe(id:string,input:z.infer<typeof probePreviewSchema>) {
    requireRole(this.actor,'maintainer');const probe=await this.probe(id),topic=await this.topic(probe.topicId);
    assertRevisionBase(probe.baseVersionId,topic.currentVersionId);
    if(!['draft','needs_review','deferred'].includes(probe.status))throw new DomainError('probe_not_draft','这条下一问已处理，请刷新后查看。',409);
    const identity=displayIdentity(input.displayMode,this.actor.displayName,input.pseudonym),question=redactPII(input.question??probe.question).publicText;
    const evidence=await this.sourceRows(topic.id);assertEvidenceReferences(probe.evidenceIds,evidence);const sourceUrls=evidence.filter(e=>probe.evidenceIds.includes(e.id)&&e.url).map(e=>e.url!).sort();
    const circleId=input.target==='zhihu_circle'?(input.circleId??topic.circleId??undefined):undefined;
    if(input.target==='zhihu_circle'&&!circleId)throw new DomainError('circle_missing','请选择已授权的知乎圈子。');
    if(input.target==='zhihu_circle'&&this.actor.mode==='live'&&process.env.ZHIHU_PUBLISH_ENABLED!=='true')throw new DomainError('publishing_disabled','维护者尚未启用知乎圈子发布。',503);
    const text=`${question}\n\n—— ${identity} · 活答案，与刘看山一起追问\n${sourceUrls.length?`参考来源：\n${sourceUrls.join('\n')}`:'这是一条邀请分享亲身经历的问题，仍有待验证。'}`;
    const payload:t.PublicationPayload={text,target:input.target,displayIdentity:identity,sourceUrls,baseVersionId:probe.baseVersionId,circleId,...(input.target==='zhihu_circle'?{title:CIRCLE_PUBLICATION_TITLE}:{})};
    const expiresAt=new Date(Date.now()+15*60_000).toISOString();
    const previewHash=contentHash({actorId:this.actor.id,workspaceId:this.actor.workspaceId,probeId:id,payload,expiresAt});
    await this.db.insert(t.consents).values({workspaceId:this.actor.workspaceId,userId:this.actor.id,purpose:`probe:${id}`,displayMode:input.displayMode,payloadHash:previewHash,preview:JSON.stringify(payload),expiresAt});
    return {...payload,title:input.target==='zhihu_circle'?CIRCLE_PUBLICATION_TITLE:undefined,previewHash,expiresAt,rateLimit:getPublicationPolicy(),providerMode:input.target==='in_app'?this.actor.mode:this.zhihu.mode};
  }
  async approveProbe(id:string,input:z.infer<typeof probeApproveSchema>,key:string) {
    requireRole(this.actor,'maintainer');
    const result=await withIdempotency(this.db,this.actor,`probe.approve:${id}`,key,input,async db=>{
      const [probe]=await db.select().from(t.probes).where(and(eq(t.probes.workspaceId,this.actor.workspaceId),eq(t.probes.id,id))).for('update');
      if(!probe)throw new DomainError('not_found','没有找到下一问。',404);
      const topic=await getTopicRecord(db,this.actor.workspaceId,probe.topicId);assertRevisionBase(probe.baseVersionId,topic.currentVersionId);
      if(!['draft','needs_review','deferred'].includes(probe.status))throw new DomainError('already_reviewed','这条下一问已经处理。',409);
      const [consent]=await db.select().from(t.consents).where(and(eq(t.consents.workspaceId,this.actor.workspaceId),eq(t.consents.userId,this.actor.id),eq(t.consents.purpose,`probe:${id}`),eq(t.consents.payloadHash,input.previewHash))).limit(1);
      if(!consent?.preview||!consent.expiresAt||new Date(consent.expiresAt).getTime()<Date.now()||consent.revokedAt)throw new DomainError('preview_expired','发布预览已过期，请重新确认。',409);
      const payload=JSON.parse(consent.preview) as t.PublicationPayload;
      const identity=displayIdentity(input.displayMode,this.actor.displayName,input.pseudonym);
      const question=redactPII(input.question??probe.question).publicText;
      const sources=await db.select().from(t.evidence).where(and(eq(t.evidence.workspaceId,this.actor.workspaceId),eq(t.evidence.topicId,topic.id),eq(t.evidence.visibility,'public')));
      assertEvidenceReferences(probe.evidenceIds,sources);
      const sourceUrls=sources.filter(e=>probe.evidenceIds.includes(e.id)&&e.url).map(e=>e.url!).sort();
      const circleId=input.target==='zhihu_circle'?(input.circleId??topic.circleId??undefined):undefined;
      const text=`${question}\n\n—— ${identity} · 活答案，与刘看山一起追问\n${sourceUrls.length?`参考来源：\n${sourceUrls.join('\n')}`:'这是一条邀请分享亲身经历的问题，仍有待验证。'}`;
      const expected:t.PublicationPayload={text,target:input.target,displayIdentity:identity,sourceUrls,baseVersionId:probe.baseVersionId,circleId,...(input.target==='zhihu_circle'?{title:CIRCLE_PUBLICATION_TITLE}:{})};
      const expectedHash=contentHash({actorId:this.actor.id,workspaceId:this.actor.workspaceId,probeId:id,payload:expected,expiresAt:new Date(consent.expiresAt).toISOString()});
      if(contentHash(payload)!==contentHash(expected)||expectedHash!==input.previewHash||consent.confirmedAt)throw new DomainError('preview_changed','发布内容、来源或范围与预览不一致，请重新确认。',409);
      if(payload.target==='zhihu_circle'&&this.actor.mode==='live'&&process.env.ZHIHU_PUBLISH_ENABLED!=='true')throw new DomainError('publishing_disabled','知乎发布尚未启用。',503);
      const [publication]=await db.insert(t.publications).values({workspaceId:this.actor.workspaceId,topicId:topic.id,probeId:id,approvalId:consent.id,approvedById:this.actor.id,providerMode:input.target==='in_app'?this.actor.mode:this.zhihu.mode,targetCircleId:payload.circleId,immutablePayload:payload,previewHash:input.previewHash,idempotencyKey:`${this.actor.id}:${key}`}).returning();
      const [updated]=await db.update(t.probes).set({question,status:'approved',reviewerId:this.actor.id,approvedAt:now()}).where(eq(t.probes.id,id)).returning();
      await db.update(t.consents).set({confirmedAt:now()}).where(eq(t.consents.id,consent.id));
      await audit(db,this.actor,topic.id,'probe.approved','probe',id,{target:payload.target,providerMode:this.actor.mode});
      await audit(db,this.actor,topic.id,'publication.requested','publication',publication.id,{target:payload.target,status:'pending'});
      return {probe:updated,publication};
    });
    return result.data;
  }
  async decideProbe(id:string,decision:'reject'|'defer',reason?:string) {
    requireRole(this.actor,'maintainer');
    return this.db.transaction(async tx=>{
      const [probe]=await tx.select().from(t.probes).where(and(eq(t.probes.workspaceId,this.actor.workspaceId),eq(t.probes.id,id))).for('update');
      if(!probe)throw new DomainError('probe_not_found','没有找到这条下一问。',404);
      if(!['draft','needs_review','deferred'].includes(probe.status))throw new DomainError('invalid_state','这条下一问已处理。',409);
      const [updated]=await tx.update(t.probes).set({status:decision==='reject'?'rejected':'deferred',reviewerId:this.actor.id,decisionReason:reason??null}).where(eq(t.probes.id,id)).returning();
      await audit(tx as unknown as AppDb,this.actor,probe.topicId,'probe.reviewed','probe',id,{decision});return {probe:updated};
    });
  }
  async proposeRevision(topicId:string,evidenceIds:string[]) {
    requireRole(this.actor,'maintainer');const topic=await this.topic(topicId),version=await this.version(topic.id,topic.currentVersionId),all=await this.sourceRows(topic.id);
    const ids=[...new Set(evidenceIds)].sort();
    if(!ids.length)throw new DomainError('evidence_required','请先选择至少一条可用证据。',400);
    assertEvidenceReferences(ids,all);const newEvidence=all.filter(e=>ids.includes(e.id));
    const existing=await this.db.select().from(t.revisions).where(and(eq(t.revisions.workspaceId,this.actor.workspaceId),eq(t.revisions.topicId,topic.id),eq(t.revisions.baseVersionId,version.id)));
    const duplicate=existing.find(r=>contentHash([...r.evidenceIds].sort())===contentHash(ids));
    if(duplicate)return {revision:duplicate,duplicate:true};
    const currentConditions=await this.db.select().from(t.conditions).where(and(eq(t.conditions.workspaceId,this.actor.workspaceId),eq(t.conditions.topicId,topic.id),eq(t.conditions.status,'active')));
    await this.modelStatus(topic.id,'loading','revision');
    try {
      const proposal=await this.llm.proposeRevision({topicId:topic.id,baseVersionId:version.id,currentText:version.text,currentConditions:currentConditions.map(c=>({id:c.id,label:c.label})),newEvidence:newEvidence.map(e=>({id:e.id,summary:e.summary}))});
      const proposedConditions=proposal.proposedConditions.map(c=>{
        const existing=currentConditions.find(old=>old.label===c.label);
        return {...c,id:existing?.id??randomUUID(),description:existing?.description??c.label,kind:existing?.kind??'context' as const,evidenceIds:c.evidenceIds.length?c.evidenceIds:(existing?.evidenceIds??[])};
      });
      const ownerRows=newEvidence.some(e=>e.experienceId)?await this.db.select({ownerId:t.experiences.ownerId}).from(t.experiences).where(and(eq(t.experiences.workspaceId,this.actor.workspaceId),inArray(t.experiences.id,newEvidence.flatMap(e=>e.experienceId?[e.experienceId]:[])))):[];
      const contributorIds=[...new Set(ownerRows.map(e=>e.ownerId))];
      const result=await this.db.transaction(async tx=>{
        const [current]=await tx.select().from(t.topics).where(and(eq(t.topics.id,topic.id),eq(t.topics.workspaceId,this.actor.workspaceId))).for('update');
        assertRevisionBase(version.id,current.currentVersionId);
        const freshEvidence=await tx.select().from(t.evidence).where(and(eq(t.evidence.workspaceId,this.actor.workspaceId),eq(t.evidence.topicId,topic.id),eq(t.evidence.visibility,'public')));
        assertEvidenceReferences(ids,freshEvidence);
        const existing=await tx.select().from(t.revisions).where(and(eq(t.revisions.workspaceId,this.actor.workspaceId),eq(t.revisions.topicId,topic.id),eq(t.revisions.baseVersionId,version.id)));
        const duplicate=existing.find(r=>contentHash([...r.evidenceIds].sort())===contentHash(ids));
        if(duplicate)return {revision:duplicate,duplicate:true};
        const [revision]=await tx.insert(t.revisions).values({...proposal,evidenceIds:ids,proposedConditions,workspaceId:this.actor.workspaceId,topicId:topic.id,baseVersionId:version.id,contributorIds}).returning();
        await audit(tx as unknown as AppDb,this.actor,topic.id,'revision.proposed','revision',revision.id,{baseVersionId:version.id,evidenceCount:newEvidence.length,providerMode:proposal.modelRun.mode});
        return {revision,duplicate:false};
      });
      await this.modelStatus(topic.id,'ready','revision',result.revision.id);
      return result;
    }catch(error){await this.modelStatus(topic.id,'failed','revision',undefined,'修订暂未整理完成，已保留原答案。');throw error;}
  }
  async decideRevision(id:string,input:z.infer<typeof revisionDecisionSchema>,key:string) {
    requireRole(this.actor,'maintainer');
    if(input.decision==='accept'&&input.confirmed!==true)throw new DomainError('confirmation_required','请确认这份修订后再发布。',403);
    const result=await withIdempotency(this.db,this.actor,`revision.decision:${id}`,key,input,async db=>{
      if(input.decision==='accept'){
        const [original]=await db.select({baseVersionId:t.revisions.baseVersionId}).from(t.revisions).where(and(eq(t.revisions.workspaceId,this.actor.workspaceId),eq(t.revisions.id,id)));
        if(!original)throw new DomainError('not_found','没有找到这份修订。',404);
        assertRevisionBase(input.baseVersionId,original.baseVersionId);
        return acceptRevisionInTransaction(db,this.actor,id,input.baseVersionId);
      }
      const [revision]=await db.select().from(t.revisions).where(and(eq(t.revisions.workspaceId,this.actor.workspaceId),eq(t.revisions.id,id))).for('update');
      if(!revision)throw new DomainError('not_found','没有找到这份修订。',404);
      if(['accepted','rejected'].includes(revision.status))throw new DomainError('already_reviewed','这份修订已经处理。',409);
      if(revision.baseVersionId!==input.baseVersionId)throw new DomainError('stale_version','请基于正确的版本审阅。',409);
      const [updated]=await db.update(t.revisions).set({status:input.decision==='reject'?'rejected':'deferred',reviewerId:this.actor.id,decidedAt:now(),decisionReason:input.reason??null}).where(eq(t.revisions.id,id)).returning();
      await audit(db,this.actor,revision.topicId,'revision.reviewed','revision',id,{decision:input.decision});return {revision:updated};
    });return result.data;
  }
  async replayReply(topicId:string,scenarioId:string) {
    requireRole(this.actor,'maintainer');if(this.actor.mode!=='replay')throw new DomainError('not_demo','演示回复只可进入独立演示工作区。',403);
    if(scenarioId!=='maintenance-followup')throw new DomainError('unknown_scenario','不存在这个演示场景。',404);
    const topic=await this.topic(topicId),snapshot=await this.zhihu.listCircleDiscussion({circleId:'demo-circle'});
    const ingested=await this.ingestItems(topic.id,snapshot.items,'circle');
    const evidence=await this.sourceRows(topic.id),sourceIds=new Set(snapshot.items.map(i=>i.sourceId));
    const ids=evidence.filter(e=>sourceIds.has(e.sourceId)).map(e=>e.id);
    if(!ids.length)throw new DomainError('no_reply','这次演示没有收到可用回复。',422);
    const existing=await this.db.select().from(t.revisions).where(and(eq(t.revisions.workspaceId,this.actor.workspaceId),eq(t.revisions.topicId,topic.id))).orderBy(desc(t.revisions.createdAt));
    const duplicate=existing.find(r=>ids.every(id=>r.evidenceIds.includes(id)));
    if(duplicate)return {revision:duplicate,duplicate:true};
    if(ingested.added)await audit(this.db,this.actor,topic.id,'discussion.reply_ingested','topic',topic.id,{scenarioId,evidenceCount:ingested.added,providerMode:'replay'});
    await this.db.update(t.probes).set({status:'answered'}).where(and(eq(t.probes.workspaceId,this.actor.workspaceId),eq(t.probes.topicId,topic.id),eq(t.probes.status,'asked')));
    return this.proposeRevision(topic.id,ids);
  }
}
