import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { AppDb } from '@/db';
import * as t from '@/db/schema';
import { getTopicDetail, getTopicRecord } from '@/db/repository';
import { contentHash, DomainError, redactPII, requireRole, type Actor, type createTopicSchema } from '@/domain';
import { createZhihuProvider } from '@/providers/zhihu';
import { sourceSnapshotSchema, type SourceItem, type ZhihuProvider } from '@/providers/contracts';
import { audit } from './services';

export class TopicService {
  constructor(readonly db:AppDb,readonly actor:Actor,readonly zhihu:ZhihuProvider=createZhihuProvider({mode:actor.mode==='replay'?'replay':undefined})) {}
  async candidates(query?:string) {
    requireRole(this.actor,'maintainer');
    const snapshot=query?await this.zhihu.searchTopics({query,limit:10}):await this.zhihu.hotList({limit:20});
    // Keep source candidates in a server snapshot, never trust copied browser summaries.
    const [anchor]=await this.db.select().from(t.topics).where(eq(t.topics.workspaceId,this.actor.workspaceId)).limit(1);
    if(!anchor)throw new DomainError('workspace_empty','请先初始化工作区。',409);
    const items=snapshot.items.filter(item=>{
      const text=`${item.title??''} ${item.summary}`;
      return Boolean(item.title?.trim())&&!redactPII(text).redactions.length&&!/(自杀方法|制作炸弹|儿童色情)/.test(text);
    });
    await this.db.insert(t.sourceSnapshots).values({workspaceId:this.actor.workspaceId,topicId:anchor.id,provider:'candidates',mode:snapshot.provenance.mode,payload:{...snapshot,items},fetchedAt:snapshot.provenance.fetchedAt});
    return {candidates:items.map(item=>({...item,candidateId:item.sourceId})),dataStatus:{mode:snapshot.provenance.mode,status:'ready',fetchedAt:snapshot.provenance.fetchedAt},filteredCount:snapshot.items.length-items.length};
  }
  async create(input:z.infer<typeof createTopicSchema>) {
    requireRole(this.actor,'maintainer');
    if(!input.sourceEvidenceIds.length)throw new DomainError('source_required','请先选择至少一条已读取的知乎来源或演示来源。',400);
    const ids=[...new Set(input.sourceEvidenceIds)];
    const existing=await this.db.select().from(t.evidence).where(and(eq(t.evidence.workspaceId,this.actor.workspaceId),eq(t.evidence.visibility,'public'),inArray(t.evidence.id,ids)));
    const snapshots=await this.db.select().from(t.sourceSnapshots).where(and(eq(t.sourceSnapshots.workspaceId,this.actor.workspaceId),eq(t.sourceSnapshots.provider,'candidates'))).orderBy(desc(t.sourceSnapshots.createdAt)).limit(20);
    const candidates=new Map<string,SourceItem>();
    for(const snapshot of snapshots){
      const parsed=sourceSnapshotSchema.safeParse(snapshot.payload);
      if(parsed.success)for(const item of parsed.data.items)if(!candidates.has(item.sourceId))candidates.set(item.sourceId,item);
    }
    const selected=ids.map(id=>({id,evidence:existing.find(e=>e.id===id),candidate:candidates.get(id)}));
    if(selected.some(s=>!s.evidence&&!s.candidate))throw new DomainError('source_not_available','选中的来源已不可用，请重新读取后选择。',409);
    const topicId=randomUUID(),versionId=randomUUID(),createdAt=new Date().toISOString();
    await this.db.transaction(async tx=>{
      await tx.insert(t.topics).values({id:topicId,workspaceId:this.actor.workspaceId,slug:`topic-${topicId.slice(0,8)}`,title:redactPII(input.title).publicText,template:input.template,summary:'这个议题正在收集不同条件下的真实经验，下一条贡献可能让答案更清楚。',creatorId:this.actor.id,circleId:input.circleId});
      const evidenceIds:string[]=[];
      for(const selectedSource of selected){
        const original=selectedSource.evidence,candidate=selectedSource.candidate;
        const [row]=await tx.insert(t.evidence).values(original?{workspaceId:this.actor.workspaceId,topicId,sourceType:original.sourceType,provider:original.provider,sourceId:original.sourceId,url:original.url,title:original.title,summary:original.summary,displayAuthor:original.displayAuthor,fetchedAt:original.fetchedAt,contentHash:original.contentHash,provenance:original.provenance,experienceId:original.experienceId}:{workspaceId:this.actor.workspaceId,topicId,sourceType:candidate!.provenance.mode==='replay'?'replay':'search',provider:candidate!.provenance.provider,sourceId:candidate!.sourceId,url:candidate!.url,title:candidate!.title,summary:candidate!.summary,displayAuthor:candidate!.author?.displayName??'来源未提供作者',fetchedAt:candidate!.provenance.fetchedAt,contentHash:contentHash(candidate!.summary),provenance:candidate!.provenance}).returning({id:t.evidence.id});
        evidenceIds.push(row.id);
      }
      const unknown={id:randomUUID(),label:'哪些条件会改变这个结论？',description:'现有摘要尚不足以确认适用条件，欢迎补充行动、限制与实际结果。',kind:'unknown' as const,evidenceIds,status:'active'};
      await tx.insert(t.conditions).values({...unknown,workspaceId:this.actor.workspaceId,topicId});
      await tx.insert(t.claimVersions).values({id:versionId,workspaceId:this.actor.workspaceId,topicId,versionNumber:1,text:'这个问题仍在收集经验。目前的材料不足以给出统一结论；请先区分具体条件，再用可追溯的经历逐步补充。',conditionsSnapshot:[unknown],evidenceIds,contributorDisplaySnapshot:[],reviewerId:this.actor.id,publishedAt:createdAt,status:'published'});
      await tx.update(t.topics).set({currentVersionId:versionId}).where(eq(t.topics.id,topicId));
      await audit(tx as unknown as AppDb,this.actor,topicId,'topic.created','topic',topicId,{evidenceCount:evidenceIds.length,providerMode:this.zhihu.mode});
    });
    return {topic:(await getTopicDetail(this.db,this.actor.workspaceId,topicId,this.actor)).topic};
  }
  async auditLog(idOrSlug:string) { requireRole(this.actor,'maintainer');return getTopicRecord(this.db,this.actor.workspaceId,idOrSlug); }
}
