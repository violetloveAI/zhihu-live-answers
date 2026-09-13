"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowUpRight, Bell, BookOpen, Check, CheckCircle2, ChevronDown, CircleHelp, Compass, Feather, GitBranch, History, Link2, Menu, MessageCircle, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Sprout, Star, X } from "lucide-react";
import type { TopicDetail, TopicSummary } from "@/db/repository";
import { Kanshan } from "./kanshan";
import { WorkspacePages } from "./workspace-pages";
import { BusyButton, Dialog, ErrorNotice, useOperation } from "./dialog";
import { dateLabel, label, request, type Session, type Theme } from "./client";
import { Avatar } from "./avatar";
import { assetPath, browserDemo } from "./runtime";
import { AgentActivityProvider, AgentCompanion, useAgentActivity } from "./agent-activity";
import { ExperienceFlow, LoginFlow, PreferencesFlow, ProbeFlow, RevisionFlow, SourcesFlow, type ContributionKind } from "./flows";
import { DiscussionPanel, ExperiencePanel, HistoryPanel, NewTopicPanel, ReportPanel, ReviewLogPanel } from "./community-panels";

type Panel = { kind: "login" | "settings" | "topics" | "history" | "experiences" | "mine" | "discussion" | "new-topic" | "audit" | "reports" | "status" } | { kind: "contribute"; contributionKind?: ContributionKind; replyToProbeId?: string } | { kind: "sources"; ids?: string[] } | { kind: "probe" | "revision" | "experience"; id: string } | { kind: "report"; entityType: string; entityId: string };
const titles: Record<Panel["kind"], string> = { login: "和看山一起，把问题想深一点", settings: "我的小本子", topics: "今天，想探索什么？", history: "答案成长记", experiences: "经验里的不同侧面", mine: "我贡献过的经历", discussion: "下一问，发到哪里了？", "new-topic": "种下一个新问题", audit: "每一步，都有迹可循", reports: "一起照看这里的内容", status: "看山手里的资料", contribute: "我也经历过", sources: "每个结论，都有来处", probe: "看看这条下一问", revision: "一起审阅答案的变化", experience: "这份经历，带来了什么？", report: "帮看山再核对一下" };
function readLocal(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function writeLocal(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Optional device preference. */ } }

type AppPage = "square" | "experiences" | "notebook";
type Library = { topics: TopicDetail[]; demoSeeded: boolean };
export function LiveApp({ page = "square" }: { page?: AppPage }) { return <AgentActivityProvider><LiveAppContent page={page} /></AgentActivityProvider>; }
function LiveAppContent({ page }: { page: AppPage }) {
  const router = useRouter();
  const [library, setLibrary] = useState<TopicDetail[]>([]);

  const [theme, setThemeState] = useState<Theme>("playground"); const [session, setSession] = useState<Session | null>(null); const [topics, setTopics] = useState<TopicSummary[]>([]); const [data, setData] = useState<TopicDetail | null>(null); const [slug, setSlug] = useState<string | null>(null); const [panel, setPanel] = useState<Panel | null>(null); const [loading, setLoading] = useState(true); const [pageError, setPageError] = useState<string | null>(null); const [toast, setToast] = useState(""); const [filter, setFilter] = useState(""); const [favorites, setFavorites] = useState<string[]>([]); const [onlyFavorites, setOnlyFavorites] = useState(false); const epoch = useRef(0); const { busy, error, run } = useOperation("asking"); const { active: activity } = useAgentActivity();
  const user = session?.user ?? null; const maintainer = user?.role === "maintainer";
  const renderEpoch = epoch.current;
  const viewRef = useRef({ page, slug, userId: user?.id, panel });
  viewRef.current = { page, slug, userId: user?.id, panel };
  const isCurrentContext = () => viewRef.current.page === page && viewRef.current.slug === slug && viewRef.current.userId === user?.id;
  const close = () => { if (isCurrentContext() && viewRef.current.panel === panel) setPanel(null); };
  const notify = (message: string) => { if (isCurrentContext() && viewRef.current.panel === panel) setToast(message); };
  const source = (ids?: string[]) => setPanel({ kind: "sources", ids });
  const contribute = (contributionKind: ContributionKind = "experience", replyToProbeId?: string) => setPanel(user ? { kind: "contribute", contributionKind, replyToProbeId } : { kind: "login" });
  async function boot() {
    const token = ++epoch.current;
    setLoading(true); setPageError(null); setData(null); setLibrary([]);
    try {
      const [s, list] = await Promise.all([request<Session>("auth/session"), request<TopicSummary[]>("topics")]);
      if (token !== epoch.current) return;
      setSession(s); setTopics(list);
      let collection: TopicDetail[] = [];
      if (page !== "square") {
        const result = s.user?.mode === "replay"
          ? await request<Library>("demo/library", {})
          : await request<Library>("library");
        if (token !== epoch.current) return;
        collection = result.topics;
        setLibrary(collection);
      }
      const fromURL = new URL(location.href).searchParams.get("topic");
      const next = list.find(t => t.slug === fromURL)?.slug ?? list[0]?.slug;
      if (next) {
        const d = collection.find(t => t.topic.slug === next) ?? await request<TopicDetail>(`topics/${encodeURIComponent(next)}`);
        if (token !== epoch.current) return;
        setSlug(next); setData(d);
      }
    } catch (e) {
      if (token === epoch.current) setPageError(e instanceof Error ? e.message : "小本子暂时没有打开。");
    } finally { if (token === epoch.current) setLoading(false); }
  }
  useEffect(() => {
    setPanel(null);
    const t = readLocal("live-answers:theme");
    if (t === "notebook" || t === "glacier" || t === "playground") setThemeState(t);
    try { const f = JSON.parse(readLocal("live-answers:favorites") ?? "[]"); if (Array.isArray(f)) setFavorites(f.filter(x => typeof x === "string")); } catch {}
    void boot();
    const pop = () => { setPanel(null); void boot(); };
    window.addEventListener("popstate", pop);
    return () => { epoch.current++; window.removeEventListener("popstate", pop); };
  }, [page]);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(""), 7000); return () => clearTimeout(timer); } }, [toast]);
  async function refresh() {
    if (!slug || renderEpoch !== epoch.current || !isCurrentContext()) return;
    const token = renderEpoch;
    const [d, list, collection] = await Promise.all([
      request<TopicDetail>(`topics/${encodeURIComponent(slug)}`), request<TopicSummary[]>("topics"),
      page === "square" ? Promise.resolve(null) : request<Library>("library")
    ]);
    if (token === epoch.current && isCurrentContext()) { setData(d); setTopics(list); if (collection) setLibrary(collection.topics); }
  }
  function workspacePanel(next: string, target: Panel) {
    const topic = library.find(item => item.topic.slug === next);
    if (!topic) { notify("这个议题尚未载入，请刷新页面后再试。"); return; }
    if (next !== slug) epoch.current++;
    setData(topic); setSlug(next); setPanel(target);
    const url = new URL(location.href); url.searchParams.set("topic", next);
    history.replaceState(null, "", url);
  }
  function workspaceContribution(next?: string) {
    if (!user) { setPanel({ kind: "login" }); return; }
    const topicSlug = next ?? slug ?? library[0]?.topic.slug;
    if (topicSlug) workspacePanel(topicSlug, { kind: "contribute", contributionKind: "experience" });
  }
  const awaiting = !!activity || !!data?.publications.some(p => ["pending", "sending"].includes(p.status)) || !!data?.experiences.some(e => ["pending", "processing"].includes(e.analysisStatus));
  useEffect(() => { if (awaiting && !loading) { const timer = setInterval(() => { if (!document.hidden) void refresh().catch(() => {}); }, 3000); return () => clearInterval(timer); } }, [awaiting, slug, page, user?.id, loading, renderEpoch]);
  const publicationsRef = useRef<TopicDetail["publications"]>([]);
  const queueRequestInFlight = useRef(false);
  useEffect(() => { publicationsRef.current = data?.publications ?? []; }, [data?.publications]);
  useEffect(() => {
    if (!awaiting || !maintainer || !user?.id || !slug || loading) return;
    const scopeEpoch = epoch.current;
    let cancelled = false;
    let lastPublicationId: string | null = null;
    const tick = async () => {
      if (cancelled || epoch.current !== scopeEpoch || document.hidden || queueRequestInFlight.current) return;
      const now = Date.now();
      const eligible = publicationsRef.current.filter(publication => publication.status === "sending" || (
        publication.status === "pending" && (!publication.nextAttemptAt || Date.parse(publication.nextAttemptAt) <= now)
      ));
      if (!eligible.length) return;
      const previous = eligible.findIndex(publication => publication.id === lastPublicationId);
      const publication = eligible[(previous + 1) % eligible.length];
      lastPublicationId = publication.id;
      queueRequestInFlight.current = true;
      try {
        await request(`publications/${encodeURIComponent(publication.id)}/process`, {});
      } catch {
        // The read-only refresh owns visible state; a later tick can resume saved work.
      } finally {
        queueRequestInFlight.current = false;
      }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [awaiting, maintainer, user?.id, user?.mode, slug, loading]);
  async function selectTopic(next: string) { if (page !== "square") { router.push(`/?topic=${encodeURIComponent(next)}`); return; } const token = ++epoch.current; setLoading(true); setPageError(null); close(); try { const d = await request<TopicDetail>(`topics/${encodeURIComponent(next)}`); if (token !== epoch.current) return; setData(d); setSlug(next); const url = new URL(location.href); url.searchParams.set("topic", next); history.pushState(null, "", url); } catch (e) { if (token === epoch.current) setPageError(e instanceof Error ? e.message : "这个议题暂时无法打开。"); } finally { if (token === epoch.current) setLoading(false); } }
  function setTheme(t: Theme) { setThemeState(t); writeLocal("live-answers:theme", t); }
  function favorite() { if (!slug) return; const next = favorites.includes(slug) ? favorites.filter(id => id !== slug) : [...favorites, slug]; setFavorites(next); writeLocal("live-answers:favorites", JSON.stringify(next)); notify(next.includes(slug) ? "已放进你的关注小本子。" : "已取消关注这个议题。"); }
  const probe = data?.probes.find(p => ["draft", "needs_review", "deferred"].includes(p.status)) ?? data?.probes.find(p => ["asked", "answered", "approved"].includes(p.status)); const revisions = data?.revisions.filter(r => ["proposed", "needs_review", "deferred"].includes(r.status)) ?? []; const experiences = data?.experiences.filter(e => e.status === "active") ?? []; const topicTitle = data?.topic.title ?? ""; const comma = topicTitle.indexOf("，");
  const common = data && user ? { data, user, onUpdated: refresh, onClose: close, notify } : null;
  return <div className={`live-app theme-${theme}`}><a className="skip-link" href="#main-content">跳到主要内容</a><div className="preview-app">{browserDemo && <aside className="browser-demo-banner" aria-label="演示版本说明"><span><strong>交互演示版</strong> · 虚构教学样例与规则演示，记录仅保存在当前浏览器</span><a href={assetPath("/submission/index.html")} target="_blank" rel="noopener">产品计划书 ↗</a><a href={assetPath("/manual/index.html")} target="_blank" rel="noopener">图文手册 ↗</a><a href={assetPath("/manual/manual.pdf")} target="_blank" rel="noopener">PDF 下载 ↗</a></aside>}<header className="app-header"><a className="wordmark" href={assetPath("/")} aria-label="活答案首页"><span className="brand-icon brand-portrait"><Image src={assetPath("/kanshan/wave.png")} alt="" width={80} height={80} unoptimized priority /></span><span>活答案<span className="wordmark-dot">.</span></span><small>好奇心俱乐部</small></a><nav aria-label="主导航"><Link href={slug ? `/?topic=${encodeURIComponent(slug)}` : "/"} className={page === "square" ? "active" : undefined} aria-current={page === "square" ? "page" : undefined}><Compass size={17} /> 答案广场</Link><Link href="/experiences" className={page === "experiences" ? "active" : undefined} aria-current={page === "experiences" ? "page" : undefined}>我的经历</Link><Link href="/notebook" className={page === "notebook" ? "active" : undefined} aria-current={page === "notebook" ? "page" : undefined}>看山的小本子</Link></nav><div className={`header-actions${page !== "square" ? " workspace-actions" : ""}`}>{page === "square" && <button className="icon-button" aria-label="查找议题" onClick={() => setPanel({ kind: "topics" })}><Search size={20} /></button>}<button className="profile-pill" onClick={() => setPanel({ kind: user ? "settings" : "login" })}>{user ? user.displayName.slice(0, 7) : "加入我们"}<ChevronDown size={14} /></button></div></header>
  <div className={`app-shell${page !== "square" ? " workspace-shell" : ""}`}>{page === "square" && <aside className="topic-sidebar"><div className="side-caption">一起探索 <span>{String(topics.length).padStart(2, "0")}</span></div>{([["learning", "学习与成长", "把知道，变成做到", BookOpen], ["social", "社会观察", "多看见一种可能", Compass]] as const).map(([template, name, subtitle, Icon]) => <button key={template} className={`topic-link ${page === "square" && data?.topic.template === template && !onlyFavorites ? "selected" : ""}`} onClick={() => { setOnlyFavorites(false); const next = topics.find(t => t.template === template); if (next) void selectTopic(next.slug); }}><span className="topic-symbol"><Icon size={19} /></span><span>{name}<small>{subtitle}</small></span></button>)}<button className={`topic-link ${onlyFavorites ? "selected" : ""}`} onClick={() => setOnlyFavorites(!onlyFavorites)}><span className="topic-symbol"><Bell size={19} /></span><span>我的关注<small>那些还想追问的事</small></span></button><div className="side-divider" /><div className="side-caption">{onlyFavorites ? "放在心上的问题" : "看山正在琢磨"}</div>{topics.filter(t => !onlyFavorites || favorites.includes(t.slug)).map((t, i) => <button key={t.id} className={`sidebar-question ${page === "square" && t.slug === slug ? "active" : ""}`} onClick={() => void selectTopic(t.slug)}><span>{String(i + 1).padStart(2, "0")}</span>{t.title}</button>)}{onlyFavorites && !topics.some(t => favorites.includes(t.slug)) && <p className="sidebar-empty">点议题旁的星星，<br />收下想继续看的问题。</p>}{maintainer && <button className="sidebar-add" onClick={() => setPanel({ kind: "new-topic" })}><Plus size={15} /> 种下一个新问题</button>}<div className="sidebar-note"><Kanshan pose="working" /><p>好问题，值得<br /><strong>慢慢长出好答案。</strong></p><span>看山的今日小记</span></div><button className="sidebar-settings" onClick={() => setPanel({ kind: "settings" })}><Settings2 size={16} /> 换一本喜欢的小本子</button><div className="sidebar-bottom"><span className="tiny-dot" /> 每一份经验，都有它的位置</div></aside>}
  <main className={`topic-main${page !== "square" ? " workspace-main" : ""}`} id="main-content" aria-busy={loading}>{page === "square" && <div className="mobile-topic-switch"><button className="secondary-button" onClick={() => setPanel({ kind: "topics" })}><Menu size={16} /> 切换议题</button><button className="icon-button" onClick={() => setPanel({ kind: "settings" })} aria-label="偏好设置"><Settings2 size={18} /></button></div>}{page !== "square" ? <WorkspacePages page={page} library={library} user={user} loading={loading} error={pageError} onRetry={() => void boot()} onOpenTopic={next => void selectTopic(next)} onExperience={(next, id) => workspacePanel(next, { kind: "experience", id })} onContribute={workspaceContribution} onProbe={(next, id) => workspacePanel(next, { kind: "probe", id })} onRevision={(next, id) => workspacePanel(next, { kind: "revision", id })} onHistory={next => workspacePanel(next, { kind: "history" })} onSources={(next, ids) => workspacePanel(next, { kind: "sources", ids })} onLogin={() => setPanel({ kind: "login" })} /> : loading || pageError || !data ? <div className="opening-state"><Kanshan pose={pageError ? "sleep" : "working"} /><h1>{loading ? "看山正在翻开小本子……" : pageError ? "小本子暂时没打开。" : "这里还没有议题。"}</h1><p>{loading ? "问题、经验和每一次变化，都在这里。" : "从一个具体的好奇开始，种下第一个问题吧。"}</p><ErrorNotice message={pageError} />{loading ? <div className="loading-line" /> : pageError ? <button className="primary-button" onClick={() => void boot()}>再试一次</button> : maintainer && <button className="primary-button" onClick={() => setPanel({ kind: "new-topic" })}>创建议题</button>}</div> : <>
  <>{browserDemo && !user && <section className="demo-welcome" aria-label="开始体验活答案"><div><strong>让新的经历，推动答案更新。</strong><p>贡献经历、核对依据、确认修订，看看一份答案如何生长。</p></div><button className="primary-button" onClick={() => setPanel({ kind: "login" })}>开始体验 <ArrowRight size={16} /></button></section>}</><div className="topic-breadcrumb"><span>{data.topic.template === "learning" ? "学习与成长" : "社会观察"}</span><span>/</span><span>一起把问题想深一点</span><button className={`favorite-button ${favorites.includes(data.topic.slug) ? "is-favorite" : ""}`} onClick={favorite} aria-pressed={favorites.includes(data.topic.slug)} aria-label="关注这个议题"><Star size={16} /></button></div><section className="topic-heading"><div className="topic-intro"><div className="eyebrow"><Sprout size={15} /> 一个还在生长的答案 <span>NO. {String(topics.findIndex(t => t.id === data.topic.id) + 1).padStart(3, "0")}</span></div><h1>{comma > 0 ? <>{topicTitle.slice(0, comma + 1)}<br />{topicTitle.slice(comma + 1).replace(/[？?]$/, "")}<span className="question-mark">？</span></> : topicTitle}</h1><p>{data.topic.summary}</p><div className="topic-meta"><span className="avatar-stack">{data.evidence.slice(0, 3).map(e => <i key={e.id}>{e.displayAuthor.slice(0, 1)}</i>)}</span><span>{data.evidence.filter(e => e.visibility === "public").length} 份依据 · {experiences.length} 份经历</span><span className="meta-separator" /><span>{user?.mode === "replay" ? "独立体验空间" : !user ? "公开议题" : "已登录"}</span></div></div><AgentCompanion agent={data.agent} /></section>
  <div className="workspace-notice"><span className="mode-tag replay">{user?.mode === "replay" ? "演示体验" : "来源可追溯"}</span><span>{user?.mode === "replay" ? (browserDemo ? "使用虚构教学样例与规则演示，操作保存在当前浏览器，不会发送到知乎。" : "使用教学素材与本地演示逻辑，操作会保存在你的独立空间。") : "每份证据标注来源；教学示例和真实知乎内容分别展示。"}</span><button onClick={() => setPanel({ kind: "status" })}>查看来源状态 <ArrowUpRight size={14} /></button></div><ErrorNotice message={error} />
  <div className="content-grid"><div className="answer-column"><article className="answer-sheet"><div className="sheet-heading"><div className="section-kicker"><span className="section-number">01</span> 目前，我们知道</div><button className="version-pill" onClick={() => setPanel({ kind: "history" })}><GitBranch size={13} /> v{data.currentVersion?.versionNumber ?? 0}.0 <ChevronDown size={12} /></button></div>{data.currentVersion ? <><h2>{data.currentVersion.text.split("。")[0]}{data.currentVersion.text.includes("。") ? "。" : ""}</h2><p className="answer-copy">{data.currentVersion.text.includes("。") ? data.currentVersion.text.slice(data.currentVersion.text.indexOf("。") + 1) : ""}</p></> : <><h2>先收集经历，让答案慢慢长出来。</h2><p className="answer-copy">这个议题还没有经过确认的答案。补充经验、查找来源，再一起审阅看山的建议。</p></>}<div className="condition-row">{data.conditions.map(c => <button key={c.id} onClick={() => source(c.evidenceIds)} className={`status-chip ${c.kind === "support" ? "supported" : c.kind === "unknown" ? "unknown" : "contested"}`} title={c.description}>{c.kind === "unknown" ? <CircleHelp size={13} /> : c.kind === "support" ? <Check size={13} /> : <GitBranch size={13} />}{c.label}</button>)}</div><div className="sheet-footer"><span><Link2 size={14} /> 每个结论，都能找到来处</span><button onClick={() => source()}>看看依据 <ArrowUpRight size={15} /></button></div></article>
  {revisions.length > 0 && <button className="revision-banner" onClick={() => setPanel({ kind: "revision", id: revisions[0].id })}><span className="revision-icon"><GitBranch size={19} /></span><span><strong>看山发现了一个新条件</strong><small>{revisions.length} 份修订等你一起看，当前答案还没有改变。</small></span><ArrowRight size={18} /></button>}
  <section className="experience-section"><div className="section-title"><h3><span className="section-number">02</span> 经验里的不同侧面</h3><button onClick={() => setPanel({ kind: "experiences" })}>全部经验 <ArrowRight size={15} /></button></div><div className="experience-cards">{experiences.slice(0, 4).map(e => <ExperienceCard key={e.id} experience={e} onClick={() => setPanel({ kind: "experience", id: e.id })} />)}{!experiences.length && data.evidence.slice(0, 2).map((e, i) => <button className="experience-card" key={e.id} onClick={() => source([e.id])}><div className="experience-top"><span className={`mini-avatar ${i % 2 ? "mint" : "peach"}`}>{e.displayAuthor.slice(0, 1)}</span><div><strong>{e.displayAuthor.replace("（教学示例）", "")}</strong><small>{e.provenance.mode === "replay" ? "教学示例" : "知乎来源"}</small></div></div><p>{e.summary}</p><div className="experience-tags"><span>点开看看依据</span></div></button>)}</div></section><button className="contribute-banner" onClick={() => contribute()}><span className="contribute-icon"><Feather size={22} /></span><span><strong>你的经历，可能正是缺少的那一块。</strong><small>不用写长文，讲讲你真正遇到的事就好。</small></span><span className="contribute-cta">我也经历过 <Plus size={16} /></span></button><section className="unknown-section"><div className="section-title"><h3><CircleHelp size={17} /> 还想一起弄明白</h3></div>{data.conditions.filter(c => c.kind === "unknown").map(c => <button key={c.id} onClick={() => source(c.evidenceIds)} className="unknown-question"><span>?</span><div><strong>{c.label}</strong><small>{c.description}</small></div><ArrowUpRight size={16} /></button>)}</section></div>
  <aside className="agent-column"><section className="probe-note"><div className="probe-label"><Sparkles size={15} /> 看山的下一问 <span>{probe ? label(probe.status) : "一起探索"}</span></div><div className="probe-quote">“{probe?.question ?? data.conditions.find(c => c.kind === "unknown")?.label ?? "还有什么经历，能帮助我们把问题想得更清楚？"}”</div><div className="probe-divider" /><div className="probe-reason"><span>为什么想问这个</span><p>{probe?.rationale ?? "不同经历可能在不同条件下成立。具体的行动与结果，会帮我们找到答案里还缺少的那部分。"}</p></div><BusyButton busy={busy} onClick={() => probe && user ? setPanel({ kind: "probe", id: probe.id }) : setPanel({ kind: "login" })}>{probe ? "一起看看这条下一问" : "加入，一起继续追问"}<ArrowRight size={16} /></BusyButton><span className="probe-footnote">由你确认，再邀请大家回答</span>{maintainer && <button className="probe-regenerate text-button" disabled={busy} onClick={() => run(async () => { await request(`topics/${data.topic.id}/probes`, {}); await refresh(); notify("看山提出了新的下一问，请先审阅。"); })}><RefreshCw size={13} /> 再想一条下一问</button>}</section><section className="history-note"><div className="section-title"><h3><History size={16} /> 答案成长记</h3><span>{String(data.versions.length).padStart(2, "0")}</span></div>{data.versions.slice(0, 3).map(v => <div className="history-line" key={v.id}><span className="history-point" /><div><strong>{v.versionNumber === 1 ? "第一份答案，长出来了" : `答案长到了 v${v.versionNumber}.0`}</strong><p>{v.conditionsSnapshot.length} 个适用条件 · {v.evidenceIds.length} 份依据</p><small>{dateLabel(v.publishedAt)} · {label(v.status)}</small></div></div>)}<button onClick={() => setPanel({ kind: "history" })}>每一次变化，都有迹可循 <ArrowRight size={14} /></button></section><button className="discussion-link" onClick={() => setPanel({ kind: "discussion" })}><MessageCircle size={17} /><span>下一问与后续回复<small>{data.publications.length} 条发送记录</small></span><ArrowRight size={16} /></button><div className="gentle-note"><MessageCircle size={16} /><p>{data.agent.message}</p></div>{maintainer && <div className="maintainer-links"><button onClick={() => setPanel({ kind: "reports" })}><ShieldCheck size={14} /> 内容反馈</button><button onClick={() => setPanel({ kind: "audit" })}><History size={14} /> 操作记录</button></div>}</aside></div><footer className="app-footer"><span>活答案 LIVE ANSWERS</span><span>真实经历 · 有据可循 · 一起生长</span><span>刘看山官方赛事素材</span></footer></>}
  </main></div></div>{toast && <div className="toast" role="status"><CheckCircle2 size={19} /><span>{toast}</span><button onClick={() => setToast("")} aria-label="关闭提示"><X size={16} /></button></div>}
  {panel && <Dialog key={`${panel.kind}:${"id" in panel ? panel.id : ""}`} title={titles[panel.kind]} onClose={close} wide={["history", "revision", "sources", "settings", "experiences", "topics", "mine"].includes(panel.kind)}>
  {panel.kind === "login" && <LoginFlow session={session} onLoggedIn={async () => { close(); await boot(); notify("你的体验空间准备好了，和看山一起开始吧。"); }} />}{panel.kind === "settings" && <PreferencesFlow session={session} theme={theme} setTheme={setTheme} onLoggedOut={async () => { close(); await boot(); notify("已退出当前身份。"); }} />}
  {panel.kind === "topics" && <div><label className="field"><span>寻找想继续探索的问题</span><input autoFocus data-autofocus="true" type="search" value={filter} onChange={e => setFilter(e.target.value)} placeholder="输入议题关键词" /></label><div className="topic-browser">{topics.filter(t => t.title.includes(filter)).map(t => <button className="topic-browser-card" key={t.id} onClick={() => void selectTopic(t.slug)}><span>{t.template === "learning" ? <BookOpen size={20} /> : <Compass size={20} />}</span><strong>{t.title}</strong><small>{t.summary}</small><em>v{t.currentVersionNumber}.0 <ArrowRight size={16} /></em></button>)}</div>{!topics.some(t => t.title.includes(filter)) && <p className="field-hint">暂时没有匹配的议题，试试另一个关键词。</p>}{maintainer && <button className="primary-button" onClick={() => setPanel({ kind: "new-topic" })}><Plus size={17} /> 创建新议题</button>}</div>}
  {data && <>{panel.kind === "sources" && <SourcesFlow data={data} user={user} onUpdated={refresh} notify={notify} focusIds={panel.ids} onContributeSource={() => contribute("evidence")} onReport={id => setPanel({ kind: "report", entityType: "evidence", entityId: id })} />}{panel.kind === "history" && <HistoryPanel data={data} onRevision={id => setPanel({ kind: "revision", id })} onSource={source} />}
  {(panel.kind === "experiences" || panel.kind === "mine") && <div><div className="experience-list">{data.experiences.filter(e => panel.kind !== "mine" || e.isOwner).map(e => <ExperienceCard key={e.id} experience={e} onClick={() => setPanel({ kind: "experience", id: e.id })} />)}</div>{!data.experiences.some(e => panel.kind !== "mine" || e.isOwner) && <div className="empty-panel"><Kanshan pose="idle" /><p>{panel.kind === "mine" ? "在这个议题里，还没有你的经历。" : "这里在等第一份亲身经历。"}<br />你遇到过的事，可能就是缺少的那块拼图。</p></div>}<button className="primary-button" onClick={() => contribute()}>我也经历过 <Feather size={17} /></button><p className="field-hint">当前议题：{data.topic.title}</p></div>}
  {panel.kind === "experience" && (() => { const e = data.experiences.find(e => e.id === panel.id); return e ? <ExperiencePanel experience={e} data={data} user={user} onUpdated={refresh} onClose={close} notify={notify} onSource={source} onReport={() => setPanel({ kind: "report", entityType: "experience", entityId: e.id })} /> : <p>这份经历暂时不可用。</p>; })()}
  {panel.kind === "discussion" && <DiscussionPanel data={data} user={user} onUpdated={refresh} notify={notify} onClose={close} onExperience={() => contribute()} onReply={id => contribute("comment", id)} onContribution={id => setPanel({ kind: "experience", id })} />}
  {panel.kind === "status" && <div><p className="flow-description">这些状态来自已保存的来源与模型记录。更新失败时，仍可以查看之前取得的资料。</p>{Object.entries(data.dataStatus).filter(([name]) => name !== "circle").map(([name, state]) => <article key={name} className="data-channel"><div><strong>{name === "search" ? "知乎搜索" : "看山的整理"}</strong><span className="mode-tag">{state.mode === "unavailable" ? "尚未连接" : state.mode === "replay" ? "演示回放" : "真实接口"} · {state.status === "stale" ? "保留旧快照" : label(state.status)}</span></div><p>{state.error ?? "来源记录已保存。"}</p><small>最近资料时间：{dateLabel(state.fetchedAt)}</small></article>)}<button className="secondary-button" onClick={() => source()}>查看来源与更新入口 <ArrowRight size={16} /></button></div>}
  {panel.kind === "revision" && (() => { const r = data.revisions.find(r => r.id === panel.id); return r ? <RevisionFlow data={data} user={user} onUpdated={refresh} onClose={close} notify={notify} revision={r} /> : <p>这份修订暂时不可用。</p>; })()}
  {common && <>{panel.kind === "contribute" && <ExperienceFlow {...common} initialKind={panel.contributionKind} replyToProbeId={panel.replyToProbeId} />}{panel.kind === "probe" && (() => { const p = data.probes.find(p => p.id === panel.id); return p ? <ProbeFlow {...common} probe={p} /> : <p>这条下一问暂时不可用。</p>; })()}{panel.kind === "report" && <ReportPanel entityType={panel.entityType} entityId={panel.entityId} onDone={() => { void refresh(); close(); }} />}{panel.kind === "new-topic" && maintainer && <NewTopicPanel user={common.user} onCreated={async t => { await refresh(); await selectTopic(t.slug); notify("新问题种下了，先从收集具体经历开始。"); }} />}{(panel.kind === "reports" || panel.kind === "audit") && maintainer && <ReviewLogPanel topicId={data.topic.id} mode={panel.kind} onUpdated={refresh} />}</>}
  </>}
  </Dialog>}
  </div>;
}

function ExperienceCard({ experience: e, onClick }: { experience: TopicDetail["experiences"][number]; onClick: () => void }) { return <button className="experience-card" onClick={onClick}><div className="experience-top"><Avatar name={e.displayName} url={e.displayAvatarUrl} /><div><strong>{e.displayName}</strong><small>{e.contributionKind === "comment" ? "评论与回复" : e.contributionKind === "evidence" ? "补充来源" : e.isOwner ? "我的经历" : "一份亲身经历"} · {label(e.status !== "active" ? e.status : e.analysisStatus)}</small></div><span className={`evidence-marker ${e.matches[0]?.relation === "support" ? "positive" : "exception"}`}>{e.matches[0] ? label(e.matches[0].relation) : ""}</span></div><p>{e.publicText}</p><div className="experience-tags">{e.extractedConditions.slice(0, 2).map((c, i) => <span key={i}>{c}</span>)}{!e.extractedConditions.length && <span>查看经历与整理结果 <ArrowUpRight size={12} /></span>}</div></button>; }
