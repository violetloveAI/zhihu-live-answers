import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppDb } from "./index";
import * as s from "./schema";
import { contentHash, PREVIEW_WORKSPACE, PUBLIC_WORKSPACE } from "../domain/index";
import type { ConditionSnapshot, ModelRun } from "../domain/index";
const seedTime="2026-09-07T00:00:00.000Z";
export const teachingTopicSlugs = ["ai-products","campus-ai"] as const;
export function teachingIds(workspaceId:string,slug:string) {
 const topicId=`${workspaceId}:${slug}`;
 return {topicId,versionId:`${topicId}:v1`,supportId:`${topicId}:prototype`,conflictId:`${topicId}:maintenance`,unknownId:`${topicId}:transfer`,contextId:`${topicId}:outcome`,probeId:`${topicId}:first-probe`,evidenceIds:[`${topicId}:sample-zhou`,`${topicId}:sample-mu`,`${topicId}:sample-lin`]};
}
export async function seedWorkspace(db:AppDb,workspaceId:string,kind:"preview"|"live"|"demo") {
 await db.transaction(async tx=>{
  const inserted=await tx.insert(s.workspaces).values({id:workspaceId,kind}).onConflictDoNothing().returning();
  if(!inserted.length) return;
  for(const slug of teachingTopicSlugs) {
   const ids=teachingIds(workspaceId,slug);const learning=slug==="ai-products";
   const title=learning?"没有编程经验，能否靠 AI 做出可持续产品？":"大学课程应该怎样使用 AI 辅助学习？";
   const text=learning?"AI 能降低原型的制作门槛。是否能持续服务真实用户，还取决于测试、维护与独立判断能力；完成演示和持续运行需要分别讨论。":"AI 可以帮助解释概念与练习，但学习效果需要通过独立完成任务检验。工具使用边界、过程记录与评价方式，应结合具体课程共同讨论。";
   await tx.insert(s.topics).values({id:ids.topicId,workspaceId,slug,title,template:learning?"learning":"social",summary:learning?"把“做出来”与“用得住”分开，看看不同经历在哪些条件下成立。":"一个可切换的社会议题教学模板：兼顾学习收益、独立判断与公开规则。"});
   const samples=learning?[
    ["小周（教学示例）","零编程经验，两天做出了可点击的作品展示；还没有真实用户与持续运行记录。"],
    ["阿沐（教学示例）","原型上线后，持续处理账号、错误与用户反馈；每周的维护比最初搭建更需要判断。"],
    ["林同学（教学示例）","通过解释代码和修改小功能学习，但尚未记录脱离 AI 后能独立解决哪些问题。"],
   ]:[
    ["小周（教学示例）","在课堂练习中用 AI 解释陌生术语，理解更快；没有做脱离工具后的测试。"],
    ["阿沐（教学示例）","课程允许 AI 辅助但要求说明过程，老师仍通过课堂独立任务了解学习情况。"],
    ["林同学（教学示例）","担心一刀切的工具限制忽视不同任务，也希望获得明确可遵守的规则。"],
   ];
   for(let i=0;i<samples.length;i++) await tx.insert(s.evidence).values({id:ids.evidenceIds[i],workspaceId,topicId:ids.topicId,sourceType:"replay",provider:"replay",sourceId:`teaching:${slug}:${i}`,title:"教学场景 · 非真实知乎内容",summary:samples[i][1],displayAuthor:samples[i][0],fetchedAt:seedTime,contentHash:contentHash(samples[i][1]),provenance:{provider:"replay",mode:"replay",fetchedAt:seedTime}});
   const conditions:ConditionSnapshot[]=[
    {id:ids.supportId,label:learning?"完成原型":"解释与练习",description:learning?"明确范围的小型演示，能较快获得可见成果。":"有具体学习目标时，AI 可以提供解释与练习线索。",kind:"support",evidenceIds:[ids.evidenceIds[0]],status:"active"},
    {id:ids.conflictId,label:learning?"持续维护":"独立能力",description:learning?"上线后的安全、测试与用户反馈需要持续投入。":"借助工具完成作业，并不能直接证明已经理解。",kind:"conflict",evidenceIds:[ids.evidenceIds[1]],status:"active"},
    {id:ids.unknownId,label:learning?"能否迁移到新问题？":"怎样公平检验学习成果？",description:learning?"还缺少脱离教程和现成提示后的独立判断记录。":"还缺少可比较的任务结果与清晰一致的评价规则。",kind:"unknown",evidenceIds:[ids.evidenceIds[2]],status:"active"},
    {id:ids.contextId,label:learning?"先说明成功标准":"先说明课程与任务",description:learning?"区分可以展示、有人使用、持续可用三个阶段。":"不同任务需要的工具边界和过程证据可能不同。",kind:"context",evidenceIds:ids.evidenceIds,status:"active"},
   ];
   for(const c of conditions) await tx.insert(s.conditions).values({id:c.id!,workspaceId,topicId:ids.topicId,label:c.label,description:c.description!,kind:c.kind!,evidenceIds:c.evidenceIds});
   await tx.insert(s.claimVersions).values({id:ids.versionId,workspaceId,topicId:ids.topicId,versionNumber:1,text,conditionsSnapshot:conditions,evidenceIds:ids.evidenceIds,contributorDisplaySnapshot:samples.map(x=>x[0]),status:"published",publishedAt:seedTime});
   await tx.update(s.topics).set({currentVersionId:ids.versionId}).where(eq(s.topics.id,ids.topicId));
   const modelRun:ModelRun={model:"kanshan-teaching-rules",mode:"replay",promptVersion:"teaching-v1",rulesVersion:"2026-09-07",inputEvidenceIds:ids.evidenceIds,createdAt:seedTime};
   await tx.insert(s.probes).values({id:ids.probeId,workspaceId,topicId:ids.topicId,question:learning?"做出第一个 AI 产品后，你独立解决过什么新问题？当时怎样判断修复确实有效？":"使用 AI 学习后，你怎样在不借助工具时验证自己确实理解？",targetUnknownId:ids.unknownId,rationale:"教学示例缺少迁移能力的具体记录，补充过程与结果有助于区分不同条件。",evidenceIds:[ids.evidenceIds[2]],informationGainExplanation:"这条追问寻求可检查的行动与结果，而不是只收集赞成或反对。",status:"draft",baseVersionId:ids.versionId,modelRun});
   await tx.insert(s.auditEvents).values({workspaceId,topicId:ids.topicId,actorMode:"system",type:"topic.seeded",entityType:"topic",entityId:ids.topicId,payloadSummary:{providerMode:"replay",scenarioId:`teaching:${slug}`,versionNumber:1}});
  }
 });
}
export async function seedBaseWorkspaces(db:AppDb) { await seedWorkspace(db,PREVIEW_WORKSPACE,"preview"); await seedWorkspace(db,PUBLIC_WORKSPACE,"live"); }
export async function createDemoWorkspace(db:AppDb):Promise<string> { const id=`demo-${randomUUID()}`;await seedWorkspace(db,id,"demo");return id; }
