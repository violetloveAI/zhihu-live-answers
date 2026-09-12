"use client";
import { useEffect, useId, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { AlertCircle, LoaderCircle, X } from "lucide-react";
import type { AgentState } from "@/db/projections";
import { OperationStatus, useAgentActivity } from "./agent-activity";
export function Dialog({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null); const titleId = useId();
  function trapTab(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const element = ref.current!;
    const focusable = [...element.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')].filter(node => node.getClientRects().length > 0);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!first) { event.preventDefault(); element.focus(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  useEffect(() => {
    const element = ref.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    // React autoFocus runs while the native dialog is still hidden.
    element.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { element.close(); document.body.style.overflow = before; if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return <dialog className={`live-dialog ${wide ? "wide" : ""}`} ref={ref} aria-labelledby={titleId} onCancel={onClose} onKeyDown={trapTab} onClick={e => { if (e.target === ref.current) { const r = ref.current.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <div className="dialog-heading"><div><span className="dialog-eyebrow">看山的小本子</span><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="关闭窗口"><X size={21} /></button></div>
    <div className="dialog-content"><OperationStatus />{children}</div>
  </dialog>;
}
export function ErrorNotice({ message }: { message?: string | null }) { return message ? <div className="error-notice" role="alert"><AlertCircle size={18} /><span>{message}</span></div> : null; }
export function BusyButton({ busy, children, className = "primary-button", ...props }: { busy?: boolean; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props} className={className} disabled={busy || props.disabled} aria-busy={busy}>{busy && <LoaderCircle className="spin" size={17} />}{children}</button>; }
export function useOperation(defaultActivity?: AgentState) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const lock = useRef(false);
  const { start, finish } = useAgentActivity(); const activityId = useId();
  useEffect(() => () => finish(activityId), [activityId, finish]);
  async function run<T>(work: () => Promise<T>, activity = defaultActivity): Promise<T | undefined> { if (lock.current) return undefined; lock.current = true; setBusy(true); setError(null); if (activity) start(activityId, activity); try { return await work(); } catch (e) { setError(e instanceof Error ? e.message : "这一步暂时没有完成，请重试。"); return undefined; } finally { lock.current = false; setBusy(false); finish(activityId); } }
  return { busy, error, setError, run };
}
