import type * as schema from "./schema";
import type { ConditionSnapshot, ModelRun, ProviderMode } from "../domain/index";

type Row<T extends { $inferSelect: unknown }> = T["$inferSelect"];
type EvidenceRow = Row<typeof schema.evidence>;
type ExperienceRow = Row<typeof schema.experiences>;
type VersionRow = Row<typeof schema.claimVersions>;
type ProbeRow = Row<typeof schema.probes>;
type RevisionRow = Row<typeof schema.revisions>;
type PublicationRow = Row<typeof schema.publications>;
type SnapshotRow = Row<typeof schema.sourceSnapshots>;
export interface PrivacyContext { evidence: EvidenceRow[]; versions?: VersionRow[]; conditions?: { id:string; evidenceIds:string[] }[]; probes?: ProbeRow[] }
export function hasUnavailableSources(ids: readonly string[], context: PrivacyContext): boolean {
  const visible = new Set(context.evidence.filter(e => e.visibility === "public").map(e => e.id));
  return ids.some(id => !visible.has(id));
}
function conditionEvidence(conditions: ConditionSnapshot[]) { return conditions.flatMap(c => c.evidenceIds); }
function baseEvidence(id: string | null | undefined, context: PrivacyContext): string[] {
  if (!id) return [];
  const version=context.versions?.find(v => v.id===id);
  return version ? [...version.evidenceIds,...conditionEvidence(version.conditionsSnapshot)] : [];
}
function modelEvidence(run: ModelRun) { return run.inputEvidenceIds; }
export function publicEvidence(row: EvidenceRow) {
  const available=row.visibility==="public";
  return { id:row.id,topicId:row.topicId,sourceType:row.sourceType,sourceId:row.sourceId,url:available?row.url:null,title:available?row.title:"来源暂不可用",summary:available?row.summary:"该条贡献已撤回或正在审核。",displayAuthor:available?row.displayAuthor:"贡献已隐藏",fetchedAt:row.fetchedAt,visibility:row.visibility,provenance:row.provenance,sourceVerification:available&&row.provenance.sourceNature==="user_provided"?"user_provided_unverified" as const:null };
}
export function publicExperience(row: ExperienceRow, viewerId?: string, hasUnavailableEvidence=false, replyToProbeQuestion:string|null=null, contentQuarantined=false) {
  const hidden=Boolean(row.withdrawnAt||row.deletedAt||contentQuarantined),hideMetadata=hidden||hasUnavailableEvidence;
  return { id:row.id,topicId:row.topicId,publicText:hidden?"贡献已撤回或正在审核":row.publicText,displayMode:row.displayMode,displayName:hidden?"贡献已隐藏":row.displayName,displayAvatarUrl:hideMetadata||row.displayMode!=="nickname"?null:row.displayAvatarUrl,contributionKind:row.contributionKind,replyToProbeId:hideMetadata?null:row.replyToProbeId,replyToProbeQuestion:hideMetadata?null:replyToProbeQuestion,sourceUrl:hideMetadata?null:row.sourceUrl,sourceVerification:!hideMetadata&&row.sourceUrl?"user_provided_unverified" as const:null,analysisStatus:hidden?"unavailable":row.analysisStatus,extractedConditions:hidden||hasUnavailableEvidence?[]:row.extractedConditions,caveats:hidden||hasUnavailableEvidence?[]:row.caveats,analysisError:row.analysisStatus==="failed"&&!hidden?"整理暂时没有完成，可以重新分析。":null,createdAt:row.createdAt,status:row.deletedAt?"deleted":row.withdrawnAt?"withdrawn":"active",isOwner:viewerId===row.ownerId,hasUnavailableEvidence };
}
export function publicVersion(row: VersionRow, sources: EvidenceRow[]) {
  const context={evidence:sources};
  const hidden=hasUnavailableSources([...row.evidenceIds,...conditionEvidence(row.conditionsSnapshot)],context);
  return { id:row.id,topicId:row.topicId,versionNumber:row.versionNumber,baseVersionId:row.baseVersionId,text:hidden?"本版本引用的贡献已撤回或正在审核，相关正文暂不展示。":row.text,conditionsSnapshot:row.conditionsSnapshot.map(c => hasUnavailableSources(c.evidenceIds,context)?{...c,label:"贡献已撤回或正在审核",description:"相关内容暂不展示。",status:"unavailable"}:c),evidenceIds:row.evidenceIds,contributorDisplaySnapshot:hidden?["部分贡献已隐藏"]:row.contributorDisplaySnapshot,reviewerDisplayName:row.reviewerId?"维护者":null,createdAt:row.createdAt,publishedAt:row.publishedAt,status:row.status,hasUnavailableEvidence:hidden };
}
export function publicProbe(row: ProbeRow, context: PrivacyContext) {
  const target=context.conditions?.find(c => c.id===row.targetUnknownId);
  const hidden=hasUnavailableSources([...row.evidenceIds,...modelEvidence(row.modelRun),...baseEvidence(row.baseVersionId,context),...(target?.evidenceIds??[])],context);
  return { id:row.id,topicId:row.topicId,question:hidden?"引用内容不可用，请重新审阅。":row.question,targetUnknownId:row.targetUnknownId,rationale:hidden?"贡献已隐藏。":row.rationale,evidenceIds:row.evidenceIds,informationGainExplanation:hidden?"来源暂不可用。":row.informationGainExplanation,status:row.status,baseVersionId:row.baseVersionId,modelRun:row.modelRun,createdAt:row.createdAt,approvedAt:row.approvedAt,hasUnavailableEvidence:hidden };
}
export function publicRevision(row: RevisionRow, context: PrivacyContext) {
  const hidden=hasUnavailableSources([...row.evidenceIds,...modelEvidence(row.modelRun),...conditionEvidence(row.proposedConditions),...row.diff.flatMap(d => d.evidenceIds),...baseEvidence(row.baseVersionId,context)],context);
  return { id:row.id,topicId:row.topicId,baseVersionId:row.baseVersionId,proposedText:hidden?"引用的贡献已撤回或正在审核。":row.proposedText,proposedConditions:hidden?[]:row.proposedConditions,diff:hidden?[]:row.diff,evidenceIds:row.evidenceIds,explanation:hidden?"来源暂不可用。":row.explanation,confidence:row.confidence,status:row.status,modelRun:row.modelRun,reviewerDisplayName:row.reviewerId?"维护者":null,decidedAt:row.decidedAt,createdAt:row.createdAt,acceptedVersionId:row.acceptedVersionId,hasUnavailableEvidence:hidden };
}
export function publicationHasUnavailableSources(row: PublicationRow, context: PrivacyContext) {
  const probe=context.probes?.find(p => p.id===row.probeId);
  const frozenIds=Array.isArray(row.immutablePayload.evidenceIds)?row.immutablePayload.evidenceIds.filter((x):x is string => typeof x==="string"):[];
  const ids=[...frozenIds,...baseEvidence(row.immutablePayload.baseVersionId,context),...(probe?[...probe.evidenceIds,...modelEvidence(probe.modelRun)]:[])];
  const frozenUrls=row.immutablePayload.sourceUrls;
  const hiddenUrl=context.evidence.some(e=>e.visibility!=="public"&&e.url&&frozenUrls.includes(e.url));
  return hasUnavailableSources(ids,context)||hiddenUrl;
}
export function publicPublication(row: PublicationRow, hasUnavailableEvidence=false) {
  return { id:row.id,topicId:row.topicId,probeId:row.probeId,providerMode:row.providerMode,target:row.immutablePayload.target,targetCircleId:row.targetCircleId,text:hasUnavailableEvidence?"引用的贡献已撤回或正在审核，讨论正文暂不展示。":row.immutablePayload.text,displayIdentity:hasUnavailableEvidence?"贡献已隐藏":row.immutablePayload.displayIdentity,status:row.status,attemptCount:row.attemptCount,nextAttemptAt:row.nextAttemptAt,remoteId:row.status==="sent"&&!hasUnavailableEvidence?row.remoteId:null,remoteUrl:row.status==="sent"&&row.providerMode==="live"&&!hasUnavailableEvidence?row.remoteUrl:null,lastError:row.lastError?"发布尚未完成，请查看任务状态并重试或核对发送结果。":null,createdAt:row.createdAt,sentAt:row.sentAt,hasUnavailableEvidence };
}

export interface DataChannelStatus {
  mode: ProviderMode | "unavailable";
  status: "ready" | "loading" | "stale" | "failed";
  fetchedAt?:string;
  lastAttemptAt?:string;
  attemptMode?:ProviderMode;
  error?:string;
}
export type AgentState="welcome"|"searching"|"analyzing"|"asking"|"awaiting_review"|"updating"|"success"|"degraded"|"empty";
export interface AgentStatus { name:"刘看山";state:AgentState;message:string;modelMode:ProviderMode|"unavailable" }
export interface StatusInput { snapshots:SnapshotRow[]; experiences:ExperienceRow[]; modelRuns:ModelRun[]; probes:ProbeRow[]; revisions:RevisionRow[]; publications:PublicationRow[]; versions:VersionRow[]; evidence:EvidenceRow[]; maintainer:boolean }
const timeValue=(time:string) => new Date(time).getTime();
function mostRecent<T>(items:T[],time:(item:T)=>string):T|undefined { return [...items].sort((a,b)=>timeValue(time(b))-timeValue(time(a)))[0]; }
function snapshotState(row:SnapshotRow):DataChannelStatus["status"] {
  if(row.lastError) return "failed";
  const status=row.payload.status;
  return status==="loading"||status==="failed"||status==="stale"?status:"ready";
}
function sourceStatus(provider:"search"|"circle",snapshots:SnapshotRow[]):DataChannelStatus {
  const list=snapshots.filter(s=>s.provider===provider);
  const latest=mostRecent(list,s=>s.fetchedAt);
  if(!latest) return {mode:"unavailable",status:"failed",error:provider==="search"?"还没有读取知乎搜索来源。":"还没有读取圈子讨论。"};
  const successful=mostRecent(list.filter(s=>snapshotState(s)==="ready"),s=>s.fetchedAt);
  const state=snapshotState(latest);
  if(state==="loading")return {mode:latest.mode,status:"loading",fetchedAt:successful?.fetchedAt,lastAttemptAt:latest.fetchedAt,attemptMode:latest.mode};
  if(state==="failed"||state==="stale")return {mode:successful?.mode??latest.mode,status:successful?"stale":"failed",fetchedAt:successful?.fetchedAt,lastAttemptAt:latest.fetchedAt,attemptMode:latest.mode,error:provider==="search"?"搜索暂时没有更新，保留最近成功获取的来源。":"圈子暂时没有更新，保留最近成功获取的讨论。"};
  return {mode:latest.mode,status:"ready",fetchedAt:latest.fetchedAt,lastAttemptAt:latest.fetchedAt,attemptMode:latest.mode};
}
/** Status is an interpretation of saved outcomes, never a claim that a configured provider was called. */
export function deriveTopicStatus(input:StatusInput):{dataStatus:Record<"search"|"circle"|"llm",DataChannelStatus>;agent:AgentStatus} {
  const search=sourceStatus("search",input.snapshots),circle=sourceStatus("circle",input.snapshots);
  const activeExperiences=input.experiences.filter(e=>!e.withdrawnAt&&!e.deletedAt);
  const pending=activeExperiences.some(e=>["pending","processing"].includes(e.analysisStatus));
  const failed=activeExperiences.some(e=>e.analysisStatus==="failed");
  const needsReview=activeExperiences.some(e=>e.analysisStatus==="needs_review");
  const modelSnapshot=mostRecent(input.snapshots.filter(s=>s.provider==="llm"),s=>s.fetchedAt);
  const recentRun=mostRecent(input.modelRuns,r=>r.createdAt);
  const successSnapshot=mostRecent(input.snapshots.filter(s=>s.provider==="llm"&&snapshotState(s)==="ready"),s=>s.fetchedAt);
  let llm:DataChannelStatus;
  if(modelSnapshot&&(!recentRun||timeValue(modelSnapshot.fetchedAt)>=timeValue(recentRun.createdAt))) {
    const state=snapshotState(modelSnapshot);
    llm={mode:modelSnapshot.mode,status:state,fetchedAt:state==="ready"?modelSnapshot.fetchedAt:successSnapshot?.fetchedAt??recentRun?.createdAt,lastAttemptAt:modelSnapshot.fetchedAt,attemptMode:modelSnapshot.mode,...(state==="failed"?{error:"刘看山这次整理没有完成，已有内容已保留，可以重试。"}:{})};
  } else if(pending) {
    // Old interrupted jobs may predate attempt logging. Do not infer their mode from an earlier run.
    llm={mode:"unavailable",status:"loading"};
  } else if(failed) {
    llm={mode:"unavailable",status:"failed",fetchedAt:recentRun?.createdAt,error:"有一份经历暂时没有完成分析，可以重新整理。"};
  } else if(recentRun) {
    llm={mode:recentRun.mode,status:"ready",fetchedAt:recentRun.createdAt};
  } else llm={mode:"unavailable",status:"failed",error:"还没有已完成的模型或演示规则记录。"};
  // An outstanding persisted analysis remains pending even if another operation finished.
  if(pending&&llm.status!=="loading")llm={...llm,status:"loading"};
  const dataStatus={search,circle,llm};
  const failedPublication=input.publications.some(p=>["retryable_failed","permanently_failed","needs_reconciliation"].includes(p.status));
  const actualSourceFailure=input.snapshots.some(s=>["search","circle"].includes(s.provider))&&[search,circle].some(s=>s.status==="stale"||(s.mode!=="unavailable"&&s.status==="failed"));
  const awaitingReview=input.maintainer&&(input.probes.some(p=>["draft","needs_review"].includes(p.status))||input.revisions.some(r=>["proposed","needs_review"].includes(r.status))||needsReview);
  const queued=input.publications.some(p=>["pending","sending"].includes(p.status));
  let state:AgentState="welcome",message="你好，我是刘看山。一起看看，不同经验在什么条件下成立。";
  if(search.status==="loading"||circle.status==="loading"){state="searching";message="我正在读取来源，已有的答案和成功快照会保留。";}
  else if(llm.status==="loading"){state=modelSnapshot?.payload.operation==="revision"?"updating":"analyzing";message=state==="updating"?"我正在整理修订建议，公开答案会等你审核后再更新。":"我正在找这条经历影响的条件，已有答案会保持原样。";}
  else if((llm.status==="failed"&&Boolean(modelSnapshot||failed))||failedPublication||actualSourceFailure){state="degraded";message=failedPublication?"发布任务需要重试或核对发送结果；我保留了已经确认的内容。":"这次更新暂时没有完成，已有答案和经历已保存，可以稍后重试。";}
  else if(input.evidence.length===0){state="empty";message="这张经验地图还没有来源，先补充一条可以核对的经历吧。";}
  else if(awaitingReview){state="awaiting_review";message="我整理出了待审内容，等你看过证据，再决定下一步。";}
  else if(queued){state="asking";message="下一问已经确认，正在等待发送；发送完成后才会显示回执。";}
  else if(input.probes.some(p=>p.status==="asked")){state="asking";message="下一问已经发出，正在等待更多具体经历。";}
  else if(input.versions.some(v=>v.status==="published"&&v.versionNumber>1)){state="success";message="新版本已经发布。你可以对照历史，看看这次经验改变了什么。";}
  return {dataStatus,agent:{name:"刘看山",state,message,modelMode:llm.mode}};
}
