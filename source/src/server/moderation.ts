import { and, eq, inArray, desc } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { AppDb } from '@/db';
import * as t from '@/db/schema';
import { DomainError, redactPII, requireRole, type Actor } from '@/domain';
import { audit } from './services';

export class ModerationService {
  constructor(readonly db:AppDb,readonly actor:Actor) {}
  private async target(db:AppDb,type:string,id:string):Promise<{topicId:string;evidenceIds:string[]}> {
    const where=(table:{id:AnyPgColumn;workspaceId:AnyPgColumn})=>and(eq(table.id,id),eq(table.workspaceId,this.actor.workspaceId));
    if(type==='evidence'){const [row]=await db.select().from(t.evidence).where(where(t.evidence));if(row)return {topicId:row.topicId,evidenceIds:[row.id]};}
    if(type==='experience'){
      const [row]=await db.select().from(t.experiences).where(where(t.experiences));
      if(row){const sources=await db.select({id:t.evidence.id}).from(t.evidence).where(and(eq(t.evidence.workspaceId,this.actor.workspaceId),eq(t.evidence.experienceId,id)));return {topicId:row.topicId,evidenceIds:sources.map(e=>e.id)};}
    }
    if(type==='probe'){const [row]=await db.select().from(t.probes).where(where(t.probes));if(row)return {topicId:row.topicId,evidenceIds:row.evidenceIds};}
    if(type==='revision'){const [row]=await db.select().from(t.revisions).where(where(t.revisions));if(row)return {topicId:row.topicId,evidenceIds:row.evidenceIds};}
    if(type==='version'){const [row]=await db.select().from(t.claimVersions).where(where(t.claimVersions));if(row)return {topicId:row.topicId,evidenceIds:row.evidenceIds};}
    throw new DomainError('not_found','没有找到要举报的内容。',404);
  }
  async report(input:{entityType:string;entityId:string;reason:string}) {
    requireRole(this.actor);
    return this.db.transaction(async tx=>{
      const db=tx as unknown as AppDb,target=await this.target(db,input.entityType,input.entityId);
      const [duplicate]=await db.select().from(t.reports).where(and(eq(t.reports.workspaceId,this.actor.workspaceId),eq(t.reports.reporterId,this.actor.id),eq(t.reports.entityType,input.entityType),eq(t.reports.entityId,input.entityId),eq(t.reports.status,'pending'))).limit(1);
      if(duplicate)return {report:this.publicReport(duplicate)};
      const [report]=await db.insert(t.reports).values({workspaceId:this.actor.workspaceId,topicId:target.topicId,reporterId:this.actor.id,entityType:input.entityType,entityId:input.entityId,reason:redactPII(input.reason).publicText}).returning();
      if(target.evidenceIds.length)await db.update(t.evidence).set({visibility:'quarantined'}).where(and(eq(t.evidence.workspaceId,this.actor.workspaceId),inArray(t.evidence.id,target.evidenceIds),eq(t.evidence.visibility,'public')));
      await audit(db,this.actor,target.topicId,'content.reported',input.entityType,input.entityId,{status:'pending'});
      return {report:this.publicReport(report)};
    });
  }
  private publicReport(row:typeof t.reports.$inferSelect){return {id:row.id,topicId:row.topicId,entityType:row.entityType,entityId:row.entityId,reason:row.reason,status:row.status,createdAt:row.createdAt,resolvedAt:row.resolvedAt,decisionReason:row.decisionReason};}
  async list(topicId?:string){requireRole(this.actor,'maintainer');return (await this.db.select().from(t.reports).where(and(eq(t.reports.workspaceId,this.actor.workspaceId),topicId?eq(t.reports.topicId,topicId):undefined)).orderBy(desc(t.reports.createdAt))).map(row=>this.publicReport(row));}
  async decide(id:string,decision:'dismiss'|'hide',reason:string){
    requireRole(this.actor,'maintainer');
    return this.db.transaction(async tx=>{
      const db=tx as unknown as AppDb;
      const [row]=await db.select().from(t.reports).where(and(eq(t.reports.workspaceId,this.actor.workspaceId),eq(t.reports.id,id))).for('update');
      if(!row)throw new DomainError('not_found','没有找到这条举报。',404);
      if(row.status!=='pending')throw new DomainError('already_reviewed','这条举报已经处理。',409);
      const target=await this.target(db,row.entityType,row.entityId);
      const [updated]=await db.update(t.reports).set({status:decision==='hide'?'hidden':'dismissed',reviewerId:this.actor.id,resolvedAt:new Date().toISOString(),decisionReason:redactPII(reason).publicText}).where(eq(t.reports.id,id)).returning();
      if(decision==='hide'&&target.evidenceIds.length)await db.update(t.evidence).set({visibility:'unavailable'}).where(and(eq(t.evidence.workspaceId,this.actor.workspaceId),inArray(t.evidence.id,target.evidenceIds)));
      if(decision==='dismiss'){
        const otherReports=await db.select().from(t.reports).where(and(eq(t.reports.workspaceId,this.actor.workspaceId),eq(t.reports.topicId,target.topicId),inArray(t.reports.status,['pending','hidden'])));
        const blocked=new Set<string>();
        for(const report of otherReports)for(const evidenceId of (await this.target(db,report.entityType,report.entityId)).evidenceIds)blocked.add(evidenceId);
        for(const evidenceId of target.evidenceIds){
          if(blocked.has(evidenceId))continue;
          const [source]=await db.select().from(t.evidence).where(and(eq(t.evidence.workspaceId,this.actor.workspaceId),eq(t.evidence.id,evidenceId)));
          if(!source||source.visibility!=='quarantined')continue;
          if(source.experienceId){const [experience]=await db.select().from(t.experiences).where(eq(t.experiences.id,source.experienceId));if(!experience||experience.withdrawnAt||experience.deletedAt)continue;}
          await db.update(t.evidence).set({visibility:'public'}).where(eq(t.evidence.id,evidenceId));
        }
      }
      await audit(db,this.actor,row.topicId,'report.reviewed','report',id,{decision,status:updated.status});
      return {report:this.publicReport(updated)};
    });
  }
}
