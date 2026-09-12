"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { AgentState, AgentStatus } from "@/db/projections";
import { Kanshan } from "./kanshan";

type ActivityContext = { active: AgentState | null; start: (id: string, state: AgentState) => void; finish: (id: string) => void };
const Context = createContext<ActivityContext>({ active: null, start: () => {}, finish: () => {} });
export function AgentActivityProvider({ children }: { children: ReactNode }) {
  const [activities, setActivities] = useState<Record<string, AgentState>>({});
  const start = useCallback((id: string, state: AgentState) => setActivities(current => ({ ...current, [id]: state })), []);
  const finish = useCallback((id: string) => setActivities(current => { if (!(id in current)) return current; const next = { ...current }; delete next[id]; return next; }), []);
  const active = Object.values(activities).at(-1) ?? null;
  const value = useMemo(() => ({ active, start, finish }), [active, start, finish]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useAgentActivity = () => useContext(Context);

const appearances: Record<AgentState, { pose: "wave" | "working" | "idle" | "sway" | "sleep" | "play"; title: string; detail: string }> = {
  welcome: { pose: "wave", title: "嘿，这里还差一块拼图。", detail: "我们一起找找？" },
  searching: { pose: "working", title: "让我找找新的线索。", detail: "正在读取来源，已有资料会保留。" },
  analyzing: { pose: "working", title: "这份经历，我在认真看。", detail: "正在整理条件与依据。" },
  asking: { pose: "sway", title: "下一个好问题，会是什么？", detail: "正在准备邀请，先由你确认。" },
  awaiting_review: { pose: "idle", title: "整理好了，想请你看看。", detail: "核对依据，再决定下一步。" },
  updating: { pose: "working", title: "答案正在长出新的一页。", detail: "正在整理变化，保留每次来处。" },
  success: { pose: "play", title: "又一起往前走了一小步！", detail: "经历和答案的变化都收好了。" },
  degraded: { pose: "sleep", title: "这一步，暂时停了一下。", detail: "已有内容已保存，可以重新试试。" },
  empty: { pose: "idle", title: "第一块拼图，会是什么？", detail: "从一份可以核对的经历开始。" },
};
export function AgentCompanion({ agent }: { agent: AgentStatus }) {
  const { active } = useAgentActivity();
  const state = active ?? agent.state, appearance = appearances[state];
  return <div className="topic-mascot" data-agent-state={state}>
    <div className="mascot-bubble" role="status" aria-live="polite" aria-atomic="true"><strong>{appearance.title}</strong><span>{state === "asking" && !active ? "问题已确认，继续收集具体经历。" : appearance.detail}</span></div>
    <Kanshan pose={appearance.pose} />
    <span className="mascot-label">你的好奇心搭子 · 刘看山</span>
  </div>;
}
export function OperationStatus() {
  const { active } = useAgentActivity();
  if (!active) return null;
  const appearance = appearances[active];
  return <div className="operation-status" role="status" aria-live="polite" data-agent-state={active}><Kanshan pose={appearance.pose} alt="" /><span><strong>{appearance.title}</strong><small>{appearance.detail}</small></span></div>;
}
