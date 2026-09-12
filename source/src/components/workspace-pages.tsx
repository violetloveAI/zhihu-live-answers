"use client";

import { useState, type ReactNode } from "react";
import { ArrowRight, BookOpen, Check, CircleHelp, Feather, GitBranch, History, Link2, MessageCircle, Plus, RefreshCw, Search, ShieldCheck, Sparkles, X } from "lucide-react";
import type { TopicDetail } from "@/db/repository";
import type { Actor } from "@/domain";
import { Avatar } from "./avatar";
import { Kanshan } from "./kanshan";
import { dateLabel, label } from "./client";
import { browserDemo } from "./runtime";
import "@/app/workspace-pages.css";

export interface WorkspacePagesProps {
  page: "experiences" | "notebook";
  library: TopicDetail[];
  user: Actor | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpenTopic: (slug: string) => void;
  onExperience: (slug: string, id: string) => void;
  onContribute: (slug?: string) => void;
  onProbe: (slug: string, id: string) => void;
  onRevision: (slug: string, id: string) => void;
  onHistory: (slug: string) => void;
  onSources: (slug: string, ids?: string[]) => void;
  onLogin: () => void;
}

type Experience = TopicDetail["experiences"][number];
type ExperienceEntry = { detail: TopicDetail; experience: Experience };
type ExperienceFilter = "all" | "experience" | "comment" | "evidence";
type NotebookFilter = "all" | "review" | "questions" | "probes" | "growth";
const kinds = { experience: "亲身经历", comment: "评论与回复", evidence: "补充来源" };
const kindIcons = { experience: Feather, comment: MessageCircle, evidence: Link2 };
const pendingProbe = (status: string) => ["draft", "needs_review", "deferred"].includes(status);
const pendingRevision = (status: string) => ["proposed", "needs_review", "deferred"].includes(status);
const recentFirst = (a: string, b: string) => (Date.parse(b) || 0) - (Date.parse(a) || 0);
const excerpt = (text: string, length = 150) => text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;
const contains = (query: string, ...values: (string | null | undefined)[]) => !query || values.some(value => value?.toLocaleLowerCase().includes(query));
function visibleContribution({ detail, experience }: ExperienceEntry) {
  return experience.status === "active" && !experience.hasUnavailableEvidence && detail.evidence.some(source => source.sourceId === experience.id && source.visibility === "public");
}
function activeConditions({ detail, experience }: ExperienceEntry) {
  if (!visibleContribution({ detail, experience })) return [];
  const ids = new Set(experience.matches.flatMap(match => match.conditionIds));
  return detail.conditions.filter(condition => condition.status === "active" && ids.has(condition.id));
}

export function WorkspacePages(props: WorkspacePagesProps) {
  const { page, user, loading, library, error, onRetry, onLogin, onContribute } = props;
  const experiencesPage = page === "experiences";
  return <div className={`workspace-page workspace-page-${page}`} aria-busy={loading}>
    <header className={`wp-heading ${experiencesPage ? "wp-journal-heading" : "wp-desk-heading"}`}>
      <div className="wp-heading-copy">
        <span className="wp-eyebrow">{experiencesPage ? <Feather size={15} aria-hidden="true" /> : <BookOpen size={15} aria-hidden="true" />}{experiencesPage ? "我的贡献档案 / MY JOURNAL" : "看山的研究桌 / RESEARCH NOTES"}</span>
        <h1>{experiencesPage ? "我的经历" : "看山的小本子"}<span className="wp-heading-mark" aria-hidden="true">{experiencesPage ? "." : "?"}</span></h1>
        <p>{experiencesPage ? "回看自己写下的经历、回复和来源，核对公开身份，管理每份贡献的状态。" : "把还没弄明白的条件摊开，看依据、核对建议，跟进大家的答案如何变化。"}</p>
      </div>
      <div className="wp-heading-action">
        {!experiencesPage && <div className="wp-desk-companion" aria-hidden="true"><Kanshan pose="working" alt="" /><span>线索在这里，<br />我们一起核对。</span></div>}
        {user && <button className="primary-button wp-primary" onClick={() => onContribute()}><Plus size={17} aria-hidden="true" />{experiencesPage ? "写一份新贡献" : "补充一份新线索"}<ArrowRight size={16} aria-hidden="true" /></button>}
      </div>
    </header>
    {error && <div className="wp-error" role="alert"><div><strong>这一页暂时没有更新成功</strong><p>{error}</p>{library.length > 0 && <small>下方保留上次打开的记录，重新读取后再确认最新状态。</small>}</div><button className="secondary-button" onClick={onRetry} disabled={loading}><RefreshCw size={16} aria-hidden="true" />重新读取</button></div>}
    {loading && !library.length ? <div className="wp-loading" role="status"><Kanshan pose="working" alt="" /><h2>正在把记录放回小本子……</h2><p>贡献、来源和每次变化，都会按议题整理好。</p><div className="wp-loading-lines" aria-hidden="true"><span /><span /><span /></div></div>
      : !user ? <GuestPage page={page} library={library} onLogin={onLogin} onOpenTopic={props.onOpenTopic} />
      : error && !library.length ? <div className="wp-empty"><Kanshan pose="sleep" alt="" /><h2>先歇一下，记录还在原来的地方</h2><p>重新读取后，就可以继续查看自己的贡献和议题进展。</p></div>
      : <>
        {user.mode === "replay" && <div className="wp-demo-note"><span className="mode-tag replay">演示空间</span><span>{browserDemo ? "虚构教学样例仅用于体验。记录保存在当前浏览器，清除网站数据会重置体验。" : "这里的演示样例用于体验流程，不代表真实用户活动。你的操作保存在当前独立空间。"}</span></div>}
        {loading && <p className="wp-refreshing" role="status">正在更新记录，已打开的内容仍可查看。</p>}
        {experiencesPage ? <ExperiencePage {...props} user={user} /> : <NotebookPage {...props} user={user} />}
      </>}
  </div>;
}

function Stats({ items }: { items: { label: string; value: number; hint: string }[] }) {
  return <dl className="wp-stats">{items.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}<span>{item.hint}</span></dd></div>)}</dl>;
}
function EmptyResult({ title, children, onClear }: { title: string; children: ReactNode; onClear?: () => void }) {
  return <div className="wp-empty"><Kanshan pose="idle" alt="" /><h2>{title}</h2><p>{children}</p>{onClear && <button className="secondary-button" onClick={onClear}><X size={15} aria-hidden="true" />清除筛选</button>}</div>;
}

function GuestPage({ page, library, onLogin, onOpenTopic }: Pick<WorkspacePagesProps, "page" | "library" | "onLogin" | "onOpenTopic">) {
  return <div className="wp-guest-layout"><section className="wp-join-card"><span className="wp-section-kicker">先从一个具体的好奇开始</span><h2>{page === "experiences" ? "把你的第一份经历，留在这里。" : "这本小本子，等你一起写。"}</h2><p>{page === "experiences" ? "加入后，你在不同议题下写过的经历、回复和来源会汇集在这里，公开身份和整理状态都能随时核对。" : "加入后，可以跟进议题的下一问、查看答案如何变化；维护者还可以集中审阅看山整理出的建议。"}</p><button className="primary-button" onClick={onLogin}>加入，一起探索<ArrowRight size={17} aria-hidden="true" /></button><span className="wp-join-note"><ShieldCheck size={15} aria-hidden="true" />每次贡献都先检查公开预览，再由你确认。</span></section><aside className="wp-guest-notes"><h2>一份经历，怎样让答案生长？</h2><ol><li><span>01</span><div><strong>写下真实的条件</strong><p>你想做什么，试过什么，最后发生了什么。</p></div></li><li><span>02</span><div><strong>把关联看清楚</strong><p>看山整理理由，保留不同经历之间的分歧。</p></div></li><li><span>03</span><div><strong>一起审阅新变化</strong><p>先看证据，确认后才写入答案的新版本。</p></div></li></ol></aside>{library.length > 0 && <section className="wp-public-topics"><h2>也可以先看看大家在讨论什么</h2><div>{library.map(detail => <button key={detail.topic.id} onClick={() => onOpenTopic(detail.topic.slug)}><span>{detail.topic.template === "learning" ? "学习与成长" : "社会观察"}</span><strong>{detail.topic.title}</strong><ArrowRight size={18} aria-hidden="true" /></button>)}</div></section>}</div>;
}

function ExperiencePage(props: WorkspacePagesProps & { user: Actor }) {
  const { library, user, onContribute, onExperience, onOpenTopic, onSources } = props;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ExperienceFilter>("all");
  const rows = library.flatMap(detail => detail.experiences.filter(experience => experience.isOwner).map(experience => ({ detail, experience }))).sort((a, b) => recentFirst(a.experience.createdAt, b.experience.createdAt));
  const linkedConditions = new Set(rows.flatMap(row => activeConditions(row).map(condition => `${row.detail.topic.id}:${condition.id}`)));
  const participating = library.filter(detail => rows.some(row => row.detail.topic.id === detail.topic.id));
  const search = query.trim().toLocaleLowerCase();
  const filtered = rows.filter(row => (filter === "all" || row.experience.contributionKind === filter) && contains(search, row.experience.publicText, row.detail.topic.title, row.experience.displayName, ...row.experience.extractedConditions, ...row.experience.matches.flatMap(match => match.reasons)));
  const clear = () => { setQuery(""); setFilter("all"); };
  return <>
    <div className="wp-content-layout wp-journal-layout"><aside className="wp-side-column wp-journal-sidebar">
      <section className="wp-profile-card"><span className="wp-section-kicker">MY CONTRIBUTION ARCHIVE</span><div className="wp-profile"><Avatar name={user.displayName} url={user.avatarUrl} /><div><strong>{user.displayName}</strong><span>{user.role === "maintainer" ? "维护者" : "经验贡献者"} · {user.mode === "replay" ? "独立演示空间" : "知乎授权身份"}</span></div></div><p>这里汇集你自己的贡献。每条记录的公开身份、内容和撤回状态，都可以单独查看。</p><Stats items={[{ label: "我的贡献记录", value: rows.length, hint: "经历、回复与来源" }, { label: "参与过的议题", value: participating.length, hint: "跨议题汇集" }, { label: "关联的当前条件", value: linkedConditions.size, hint: "仍可查看的整理关联" }]} /></section>
      <section className="wp-journal-privacy"><ShieldCheck size={20} aria-hidden="true" /><div><h2>分享的边界，由你决定</h2><p>打开贡献详情，可以核对公开内容与身份，撤回或删除自己的贡献。</p></div></section>
      {participating.length > 0 && <section className="wp-topic-shortcuts"><h2>我参与的问题</h2>{participating.map(detail => <button key={detail.topic.id} onClick={() => onOpenTopic(detail.topic.slug)}><span>{detail.topic.title}</span><ArrowRight size={16} aria-hidden="true" /></button>)}</section>}
    </aside><section className="wp-contributions" aria-label="我的贡献列表">
      <div className="wp-section-heading"><div><span className="wp-section-kicker">MY CONTRIBUTIONS</span><h2>我写下的每一份</h2></div><span className="wp-result-count" role="status">显示 {filtered.length} / {rows.length} 份贡献</span></div>
      <div className="wp-toolbar"><div className="wp-filter-list" role="group" aria-label="按贡献类型筛选">{([["all", "全部"], ["experience", "亲身经历"], ["comment", "评论与回复"], ["evidence", "补充来源"]] as const).map(([value, name]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{name}<span>{value === "all" ? rows.length : rows.filter(row => row.experience.contributionKind === value).length}</span></button>)}</div><label className="wp-search"><Search size={17} aria-hidden="true" /><span className="wp-sr-only">搜索我的贡献</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索内容、议题或关联条件" maxLength={200} /></label></div>
      {filtered.length ? <div className="wp-contribution-list">{filtered.map((row, index) => <ContributionCard key={row.experience.id} row={row} position={index + 1} demo={user.mode === "replay"} onExperience={onExperience} onOpenTopic={onOpenTopic} onSources={onSources} />)}</div>
        : rows.length ? <EmptyResult title="没有找到这类贡献" onClear={clear}>换个关键词，或清除筛选，再看看你写过的其他记录。</EmptyResult>
        : <div className="wp-empty"><Kanshan pose="wave" alt="" /><h2>第一份经历，就从一件小事开始</h2><p>记录一个具体的目标、行动和结果。不必写得完整，条件可以慢慢补充。</p><button className="primary-button" onClick={() => onContribute()}>写下第一份贡献<ArrowRight size={16} aria-hidden="true" /></button></div>}
    </section></div>
  </>;
}

function ContributionCard({ row, position, demo, onExperience, onOpenTopic, onSources }: { row: ExperienceEntry; position: number; demo: boolean } & Pick<WorkspacePagesProps, "onExperience" | "onOpenTopic" | "onSources">) {
  const { detail, experience } = row;
  const Icon = kindIcons[experience.contributionKind];
  const conditions = activeConditions(row);
  const available = visibleContribution(row);
  const status = experience.status !== "active" ? label(experience.status) : !available ? "暂不可见" : experience.analysisStatus === "failed" ? "整理待重试" : label(experience.analysisStatus);
  const reasons = available ? experience.matches.flatMap(match => match.reasons).filter((reason, index, all) => all.indexOf(reason) === index) : [];
  return <article className="wp-contribution-card" data-experience-id={experience.id}>
    <span className="wp-journal-index" aria-hidden="true">{String(position).padStart(2, "0")}</span>
    <div className="wp-card-top"><span className="wp-kind"><Icon size={15} aria-hidden="true" />{kinds[experience.contributionKind]}</span><span className={`wp-status ${experience.analysisStatus === "failed" || !available ? "wp-status-muted" : ""}`}>{status}</span>{demo && <span className="wp-demo-label">演示记录</span>}</div>
    <button className="wp-topic-label" onClick={() => onOpenTopic(detail.topic.slug)}>{detail.topic.title}<ArrowRight size={14} aria-hidden="true" /></button>
    <p className="wp-contribution-text">{experience.publicText}</p>
    <div className="wp-contribution-byline"><Avatar name={experience.displayName} url={experience.displayAvatarUrl} /><span>{experience.displayName}<small>{experience.displayMode === "anonymous" ? "匿名分享" : experience.displayMode === "pseudonym" ? "以化名分享" : "以昵称分享"}</small></span><time dateTime={experience.createdAt}>{dateLabel(experience.createdAt)}</time></div>
    {experience.replyToProbeQuestion && <div className="wp-reply-note"><MessageCircle size={14} aria-hidden="true" /><span>回应的下一问：{excerpt(experience.replyToProbeQuestion, 85)}</span></div>}
    {conditions.length > 0 && <div className="wp-condition-links" aria-label="关联的条件">{conditions.slice(0, 3).map(condition => <button key={condition.id} onClick={() => onSources(detail.topic.slug, condition.evidenceIds)}><Link2 size={13} aria-hidden="true" />{condition.label}</button>)}{conditions.length > 3 && <span>另有 {conditions.length - 3} 个条件，可在详情查看</span>}</div>}
    <details className="wp-reason wp-journal-reason"><summary><Sparkles size={15} aria-hidden="true" /><span>{reasons.length ? "看山为什么关联到这里" : "整理进展"}</span><Plus size={14} aria-hidden="true" /></summary><p>{reasons[0] ?? (!available ? "这条贡献当前不公开展示，可打开详情查看管理状态。" : experience.analysisStatus === "failed" ? "内容已经保存。打开详情后，可以请看山再整理一次。" : ["pending", "processing"].includes(experience.analysisStatus) ? "看山正在整理这份贡献，已有内容会保留。" : "暂时没有可展示的关联，具体条件还可以继续补充。")}</p></details>
    <div className="wp-card-footer">{experience.sourceUrl ? <span><Link2 size={14} aria-hidden="true" />附有原始来源 · 待核对</span> : <span>{conditions.length ? `${conditions.length} 个条件有关联` : "每份贡献，都保留来处"}</span>}<button onClick={() => onExperience(detail.topic.slug, experience.id)}>查看贡献与整理<ArrowRight size={16} aria-hidden="true" /></button></div>
  </article>;
}

function NotebookPage(props: WorkspacePagesProps & { user: Actor }) {
  const { library, user, onOpenTopic, onSources, onHistory, onProbe, onRevision, onContribute } = props;
  const [filter, setFilter] = useState<NotebookFilter>("all");
  const [query, setQuery] = useState("");
  const maintainer = user.role === "maintainer";
  const search = query.trim().toLocaleLowerCase();
  const probes = library.flatMap(detail => detail.probes.map(probe => ({ detail, probe }))).sort((a, b) => recentFirst(a.probe.createdAt, b.probe.createdAt));
  const revisions = library.flatMap(detail => detail.revisions.map(revision => ({ detail, revision }))).sort((a, b) => recentFirst(a.revision.createdAt, b.revision.createdAt));
  const versions = library.flatMap(detail => detail.versions.map(version => ({ detail, version }))).sort((a, b) => recentFirst(a.version.publishedAt ?? a.version.createdAt, b.version.publishedAt ?? b.version.createdAt));
  const reviewProbes = maintainer ? probes.filter(row => pendingProbe(row.probe.status)) : [];
  const reviewRevisions = maintainer ? revisions.filter(row => pendingRevision(row.revision.status)) : [];
  const pendingCount = reviewProbes.length + reviewRevisions.length;
  const questions = library.flatMap(detail => detail.conditions.filter(condition => condition.kind === "unknown" && condition.status === "active").map(condition => ({ detail, condition })));
  const visibleQuestions = questions.filter(row => contains(search, row.condition.label, row.condition.description, row.detail.topic.title));
  const visibleProbes = probes.filter(row => contains(search, row.probe.question, row.probe.rationale, row.detail.topic.title));
  const visibleRevisions = revisions.filter(row => contains(search, row.revision.explanation, row.revision.proposedText, row.detail.topic.title));
  const visibleVersions = versions.filter(row => contains(search, row.version.text, row.detail.topic.title));
  const showReview = maintainer && ["all", "review"].includes(filter);
  const selectedProbes = filter === "review" ? visibleProbes.filter(row => pendingProbe(row.probe.status)) : filter === "all" && maintainer ? visibleProbes.filter(row => !pendingProbe(row.probe.status)) : visibleProbes;
  const shownReviewProbes = visibleProbes.filter(row => pendingProbe(row.probe.status));
  const shownReviewRevisions = visibleRevisions.filter(row => pendingRevision(row.revision.status));
  const showProbes = ["all", "probes"].includes(filter);
  const showGrowth = ["all", "growth"].includes(filter);
  const showQuestions = ["all", "questions"].includes(filter);
  const publicRevisions = visibleRevisions.filter(row => !pendingRevision(row.revision.status) || !maintainer);
  const resultCount = (showReview ? shownReviewProbes.length + shownReviewRevisions.length : 0) + (showQuestions ? visibleQuestions.length : 0) + (showProbes ? selectedProbes.length : 0) + (showGrowth ? visibleVersions.length + publicRevisions.length : 0);
  const clear = () => { setQuery(""); setFilter("all"); };
  const openProbe = (row: typeof probes[number]) => onProbe(row.detail.topic.slug, row.probe.id);
  const openRevision = (row: typeof revisions[number]) => onRevision(row.detail.topic.slug, row.revision.id);
  return <div className="wp-research-desk">
    <div className="wp-desk-overview"><div className="wp-desk-title"><BookOpen size={19} aria-hidden="true" /><div><strong>摊开问题，一起琢磨</strong><span>{library.length} 个议题的研究进展</span></div></div><dl className="wp-desk-counts"><div><dt>待验证条件</dt><dd>{questions.length}</dd></div><div><dt>{maintainer ? "待我审阅" : "已发出的下一问"}</dt><dd>{maintainer ? pendingCount : probes.filter(row => ["asked", "answered"].includes(row.probe.status)).length}</dd></div><div><dt>答案版本</dt><dd>{versions.length}</dd></div></dl></div>
    <div className="wp-notebook-toolbar"><div className="wp-filter-list" role="group" aria-label="筛选小本子记录">{([["all", "全部记录"], ["questions", "待验证"], ...(maintainer ? [["review", "待我审阅"]] : []), ["probes", "下一问"], ["growth", "答案成长"]] as [NotebookFilter, string][]).map(([value, name]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{name}{value === "review" && <span>{pendingCount}</span>}</button>)}</div><label className="wp-search"><Search size={17} aria-hidden="true" /><span className="wp-sr-only">搜索小本子记录</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索待验证条件、问题或修订" maxLength={200} /></label></div>
    <div className="wp-content-layout wp-notebook-layout"><div className="wp-notebook-main"><p className="wp-result-summary" role="status">{filter === "review" ? "待审记录" : "当前筛选"} · {resultCount} 条</p>
      {showQuestions && visibleQuestions.length > 0 && <section className="wp-question-board" aria-label="待验证条件"><div className="wp-section-heading"><div><span className="wp-section-kicker">OPEN QUESTIONS</span><h2>这几处，还想弄明白</h2></div><CircleHelp size={21} aria-hidden="true" /></div><p className="wp-section-description">这些是当前答案中仍待验证的条件。先看看已有依据，再补上自己的线索。</p><div className="wp-question-grid">{visibleQuestions.map(({ detail, condition }, index) => <article className="wp-question-card" key={condition.id} data-condition-id={condition.id}><div className="wp-question-top"><span>待验证</span><span aria-hidden="true">Q{String(index + 1).padStart(2, "0")}</span></div><span className="wp-agenda-topic">{detail.topic.title}</span><h3>{condition.label}</h3>{condition.description && <p>{excerpt(condition.description, 110)}</p>}<div className="wp-question-actions"><button onClick={() => onSources(detail.topic.slug, condition.evidenceIds)}><Link2 size={14} aria-hidden="true" />查看已有依据<ArrowRight size={14} aria-hidden="true" /></button><button onClick={() => onContribute(detail.topic.slug)}><Plus size={14} aria-hidden="true" />为这个议题补充经历</button></div></article>)}</div></section>}
      {showReview && shownReviewProbes.length + shownReviewRevisions.length > 0 && <section className="wp-agenda-section"><div className="wp-section-heading"><div><span className="wp-section-kicker">先一起核对</span><h2>等你看过，再往前一步</h2></div><ShieldCheck size={21} aria-hidden="true" /></div><p className="wp-section-description">这些都是尚待确认的建议，公共答案会等审阅后再更新。</p><div className="wp-agenda-list">{shownReviewRevisions.map(row => <RevisionCard key={row.revision.id} detail={row.detail} revision={row.revision} canReview onOpen={() => openRevision(row)} />)}{shownReviewProbes.map(row => <ProbeCard key={row.probe.id} detail={row.detail} probe={row.probe} canReview onOpen={() => openProbe(row)} />)}</div></section>}
      {showProbes && selectedProbes.length > 0 && <section className="wp-agenda-section"><div className="wp-section-heading"><div><span className="wp-section-kicker">沿着好奇继续想</span><h2>看山的下一问</h2></div><MessageCircle size={21} aria-hidden="true" /></div><div className="wp-agenda-list">{selectedProbes.map(row => <ProbeCard key={row.probe.id} detail={row.detail} probe={row.probe} canReview={maintainer && pendingProbe(row.probe.status)} onOpen={() => openProbe(row)} />)}</div></section>}
      {showGrowth && (visibleVersions.length > 0 || publicRevisions.length > 0) && <section className="wp-growth-section"><div className="wp-section-heading"><div><span className="wp-section-kicker">每一次变化，都有来处</span><h2>答案成长记</h2></div><History size={21} aria-hidden="true" /></div><div className="wp-version-timeline">{visibleVersions.map(({ detail, version }) => <article key={version.id} className="wp-version-entry"><span className="wp-version-dot" aria-hidden="true" /><div className="wp-version-meta"><strong>v{version.versionNumber}.0</strong><span>{label(version.status)}</span><time dateTime={version.publishedAt ?? version.createdAt}>{dateLabel(version.publishedAt ?? version.createdAt)}</time></div><h3>{detail.topic.title}</h3><p>{excerpt(version.text, 165)}</p><div className="wp-version-footer"><span>{version.conditionsSnapshot.filter(condition => condition.status !== "unavailable").length} 个可查看条件 · {version.evidenceIds.length} 份依据</span><button onClick={() => onHistory(detail.topic.slug)}>查看版本与变化<ArrowRight size={15} aria-hidden="true" /></button></div></article>)}</div>{publicRevisions.length > 0 && <div className="wp-reviewed-revisions"><h3>修订处理记录</h3>{publicRevisions.map(row => <RevisionCard key={row.revision.id} detail={row.detail} revision={row.revision} canReview={false} onOpen={() => openRevision(row)} />)}</div>}</section>}
      {!resultCount && <EmptyResult title={filter === "review" && !search ? "这一页暂时没有待审项" : search ? "小本子里还没有匹配的记录" : "先留下一条可以继续想的线索"} onClear={filter !== "all" || search ? clear : undefined}>{filter === "review" && !search ? "可以回到全部记录看看答案的变化，或从右侧的来源继续探索。" : search ? "换个关键词，或清除筛选，看看其他议题的记录。" : "从一份经历或来源开始，看山会帮忙整理，再由大家核对。"}</EmptyResult>}
    </div><aside className="wp-side-column"><section className="wp-side-note wp-notebook-note"><Kanshan pose="idle" alt="" /><h2>答案还可以继续长大</h2><p>不知道的地方，也值得好好记录。具体的经历，往往就是下一步的方向。</p><button onClick={() => onContribute()}>我有一条新线索<ArrowRight size={15} aria-hidden="true" /></button></section><section className="wp-source-shelf"><div className="wp-section-heading"><h2>从依据继续想</h2><Link2 size={18} aria-hidden="true" /></div>{library.length ? library.map(detail => {
      const unknowns = detail.conditions.filter(condition => condition.kind === "unknown" && condition.status === "active");
      const sourceCount = detail.evidence.filter(source => source.visibility === "public").length;
      return <article key={detail.topic.id}><button className="wp-shelf-topic" onClick={() => onOpenTopic(detail.topic.slug)}>{detail.topic.title}<ArrowRight size={14} aria-hidden="true" /></button><span>{sourceCount} 份可查看来源 · {unknowns.length} 个待验证条件</span>{unknowns.slice(0, 2).map(condition => <button className="wp-unknown-link" key={condition.id} onClick={() => onSources(detail.topic.slug, condition.evidenceIds)}><CircleHelp size={15} aria-hidden="true" /><span>{condition.label}</span></button>)}<button className="wp-shelf-action" onClick={() => onSources(detail.topic.slug)}>查看这个议题的依据<ArrowRight size={14} aria-hidden="true" /></button></article>;
    }) : <p>议题建立后，来源和待验证条件会整理在这里。</p>}</section></aside></div>
  </div>;
}

function ProbeCard({ detail, probe, canReview, onOpen }: { detail: TopicDetail; probe: TopicDetail["probes"][number]; canReview: boolean; onOpen: () => void }) {
  const outdated = probe.baseVersionId !== detail.topic.currentVersionId || probe.hasUnavailableEvidence;
  return <article className="wp-agenda-card wp-agenda-probe"><div className="wp-card-top"><span className="wp-kind"><MessageCircle size={15} aria-hidden="true" />下一问</span><span className="wp-status">{label(probe.status)}</span>{probe.modelRun.mode === "replay" && <span className="wp-demo-label">演示逻辑</span>}</div><span className="wp-agenda-topic">{detail.topic.title}</span><h3>{probe.question}</h3><p>{probe.rationale}</p>{outdated && <p className="wp-attention">{probe.hasUnavailableEvidence ? "相关来源暂不可用，请先核对依据。" : "答案已有更新，这条问题需要结合当前版本核对。"}</p>}<div className="wp-card-footer"><time dateTime={probe.createdAt}>{dateLabel(probe.createdAt)}</time><button onClick={onOpen}>{canReview ? outdated ? "核对问题与依据" : "审阅这条下一问" : "查看下一问"}<ArrowRight size={16} aria-hidden="true" /></button></div></article>;
}
function RevisionCard({ detail, revision, canReview, onOpen }: { detail: TopicDetail; revision: TopicDetail["revisions"][number]; canReview: boolean; onOpen: () => void }) {
  const outdated = revision.baseVersionId !== detail.topic.currentVersionId && pendingRevision(revision.status);
  const added = revision.diff.filter(change => change.kind === "added").length;
  return <article className="wp-agenda-card wp-agenda-revision"><div className="wp-card-top"><span className="wp-kind"><GitBranch size={15} aria-hidden="true" />答案修订</span><span className="wp-status">{label(revision.status)}</span>{revision.modelRun.mode === "replay" && <span className="wp-demo-label">演示逻辑</span>}</div><span className="wp-agenda-topic">{detail.topic.title}</span><h3>{revision.hasUnavailableEvidence ? "先核对这份修订的来源" : canReview ? "新的经历，带来了哪些变化？" : "这份修订留下的记录"}</h3><p>{revision.explanation}</p><div className="wp-revision-summary"><span><Link2 size={14} aria-hidden="true" />{revision.evidenceIds.length} 份依据</span><span><GitBranch size={14} aria-hidden="true" />{revision.diff.length} 处建议变化{added ? ` · ${added} 处新增` : ""}</span></div>{(outdated || revision.hasUnavailableEvidence) && <p className="wp-attention">{revision.hasUnavailableEvidence ? "相关来源暂不可用，请先核对依据。" : "这份建议基于旧版本，需要重新核对，当前答案保持原样。"}</p>}<div className="wp-card-footer"><time dateTime={revision.createdAt}>{dateLabel(revision.createdAt)}</time><button onClick={onOpen}>{canReview ? "查看变化并审阅" : "查看修订记录"}<ArrowRight size={16} aria-hidden="true" /></button></div></article>;
}
