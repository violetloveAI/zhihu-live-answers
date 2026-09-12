# TopicDetail DTO contract

Source of truth: `TopicDetail = Awaited<ReturnType<typeof getTopicDetail>>` exported by `src/db/repository.ts`. The following describes that exact public projection after the privacy/status audit. Import this type with `import type` in client code.

```ts
{
  topic: {
    id, slug, title, template: 'learning' | 'social', summary,
    currentVersionId: string | null, circleId: string | null,
    status, createdAt, updatedAt
  },
  currentVersion: ClaimVersionPublic | null,
  conditions: Array<{
    id, label, description, kind: 'support' | 'conflict' | 'unknown' | 'context',
    evidenceIds: string[], status: string
  }>,
  evidence: EvidencePublic[],
  experiences: Array<ExperiencePublic & { matches: MatchPublic[] }>,
  probes: ProbePublic[],
  revisions: RevisionPublic[],
  publications: PublicationPublic[],
  versions: ClaimVersionPublic[],
  agent: {
    name: '刘看山',
    state: 'welcome' | 'searching' | 'analyzing' | 'asking' | 'awaiting_review'
      | 'updating' | 'success' | 'degraded' | 'empty',
    message: string,
    modelMode: 'live' | 'replay' | 'unavailable'
  },
  dataStatus: Record<'search' | 'circle' | 'llm', {
    mode: 'live' | 'replay' | 'unavailable',
    status: 'ready' | 'loading' | 'stale' | 'failed',
    fetchedAt?: string,
    lastAttemptAt?: string,
    attemptMode?: 'live' | 'replay',
    error?: string
  }>
}
```

All unannotated scalar fields in the outlines below are strings, except explicit arrays/numbers/booleans/nulls. Dates are UTC timestamp strings; the UI may format them with `new Date(value)`.

- `EvidencePublic`: `id, topicId, sourceType, sourceId, url:string|null, title:string|null, summary, displayAuthor, fetchedAt, visibility, provenance`.
- `ExperiencePublic`: `id, topicId, publicText, displayMode, displayName, analysisStatus, extractedConditions:string[], caveats:string[], analysisError:string|null, createdAt, status:'active'|'withdrawn'|'deleted', isOwner:boolean, hasUnavailableEvidence:boolean`. A removed experience has `analysisStatus='unavailable'`; otherwise analysis status is pending/processing/ready/needs_review/failed.
- `MatchPublic`: `id, conditionIds:string[], evidenceIds:string[], relation, reasons:string[], confidence:number, modelRun`.
- `ProbePublic`: `id, topicId, question, targetUnknownId, rationale, evidenceIds:string[], informationGainExplanation, status, baseVersionId, modelRun, createdAt, approvedAt:string|null, hasUnavailableEvidence:boolean`.
- `RevisionPublic`: `id, topicId, baseVersionId, proposedText, proposedConditions:ConditionSnapshot[], diff:VersionDiff[], evidenceIds:string[], explanation, confidence:number, status, modelRun, reviewerDisplayName:string|null, decidedAt:string|null, createdAt, acceptedVersionId:string|null, hasUnavailableEvidence:boolean`.
- `PublicationPublic`: `id, topicId, probeId, providerMode, target:'in_app'|'zhihu_circle', targetCircleId:string|null, text, displayIdentity, status, attemptCount:number, nextAttemptAt:string|null, remoteId:string|null, remoteUrl:string|null, lastError:string|null, createdAt, sentAt:string|null, hasUnavailableEvidence:boolean`.
- `ClaimVersionPublic`: `id, topicId, versionNumber:number, baseVersionId:string|null, text, conditionsSnapshot:ConditionSnapshot[], evidenceIds:string[], contributorDisplaySnapshot:string[], reviewerDisplayName:string|null, createdAt, publishedAt:string|null, status:'draft'|'published'|'superseded', hasUnavailableEvidence:boolean`. `TopicDetail.currentVersion` only returns a published row; `versions` excludes drafts.

`ConditionSnapshot` and `VersionDiff` are exported from `src/domain/index.ts`. `modelRun` contains only model/mode/promptVersion/rulesVersion/inputEvidenceIds/createdAt; `provenance` describes the source's original provider/mode/fetchedAt and optional request or snapshot metadata.

## Behavioral meaning for the interface

- Use `hasUnavailableEvidence` to explain why a card's text is hidden and disable approving that stale card. The service/outbox still enforces the check independently.
- Missing, withdrawn and quarantined evidence hides both direct and transitive generated text: model inputs, condition sources, revision baseline/diff, frozen publication baseline. Another person's still-public experience text remains readable, but affected derived matches and caveats disappear.
- Anonymous/contributor reads only include asked/answered probes, reviewed revisions (accepted/rejected/deferred) and sent publications. Maintainers receive pending items too, through the same privacy projection.
- `mode='unavailable'` means no trustworthy recorded mode/capability result exists. A teaching fixture alone does not mean the Zhihu search/circle APIs have run.
- When a live source refresh fails but an older replay snapshot exists: `mode='replay'`, `status='stale'`, `fetchedAt` is the successful snapshot's time; `attemptMode='live'`, `lastAttemptAt` describes the failed attempt. Do not label cached replay evidence as live.
- `agent.state='updating'` means a persisted revision-generation operation is in progress; the message explicitly says the public answer still awaits review. `success` requires an actual published version above v1.
- `rawText`, owner/provider identities, consent records, OAuth data, reviewer IDs, contributor IDs, lease fields and approved-payload internals are never projected.

## Mutation reuse

Prefer finishing a mutation, then reading `getTopicDetail(db, actor.workspaceId, topicId, actor)` and finding the changed object there. This guarantees identical privacy behavior for GET and mutation responses.

Standalone helpers `publicProbe`, `publicRevision`, `publicationHasUnavailableSources` take a privacy context with full same-topic evidence, versions, conditions and probes. Passing only the new evidence is insufficient to protect baseline/diff text.

`acceptRevisionInTransaction(tx, actor, revisionId, expectedBaseVersionId)` executes inside an existing transaction. Use it from `withIdempotency`; the original `acceptRevision` remains a standalone transaction wrapper.
