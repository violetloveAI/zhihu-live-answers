import type { Actor } from "@/domain";
import type { getAuthCapabilities } from "@/server/auth";
import { browserDemo } from "./runtime";
export type Session = { user: Actor | null; capabilities: Awaited<ReturnType<typeof getAuthCapabilities>> };
export type Theme = "notebook" | "glacier" | "playground";
export const themes: { id: Theme; label: string; description: string }[] = [
  { id: "notebook", label: "看山的研究手帐", description: "奶油纸张 · 温暖陪伴" },
  { id: "glacier", label: "极地知识站", description: "冰川蓝 · 清透留白" },
  { id: "playground", label: "好奇心俱乐部", description: "漫画线条 · 明亮钴蓝" },
];
export class RequestError extends Error { constructor(message: string, public code: string, public retryable: boolean) { super(message); } }
const pendingKeys = new Map<string, string>();
export async function request<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const fingerprint = `${method}:${path}:${serialized ?? ""}`;
  if (method !== "GET" && !pendingKeys.has(fingerprint)) pendingKeys.set(fingerprint, crypto.randomUUID());
  const response = browserDemo
    ? await (await import("@/demo/browser-api")).browserResponse(path, body, method, pendingKeys.get(fingerprint))
    : await fetch(`/api/${path}`, { method, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(method === "GET" ? {} : { "Idempotency-Key": pendingKeys.get(fingerprint)! }) }, body: serialized });
  let result: { data?: T; error?: { message?: string; code?: string; retryable?: boolean } };
  try { result = await response.json(); } catch { throw new RequestError("连接暂时中断，请稍后重试。", "invalid_response", true); }
  if (!response.ok || result.error) {
    if (!result.error?.retryable) pendingKeys.delete(fingerprint);
    throw new RequestError(result.error?.message ?? "这一步暂时没有完成，请重试。", result.error?.code ?? "request_failed", result.error?.retryable ?? false);
  }
  pendingKeys.delete(fingerprint);
  return result.data as T;
}
export function dateLabel(value?: string | null) { if (!value) return "尚无记录"; return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(value)); }
export const statusLabels: Record<string, string> = { draft: "待确认", proposed: "待审阅", needs_review: "需要再核对", approved: "已确认", asked: "已发出", answered: "有新回复", rejected: "未采纳", deferred: "稍后再看", expired: "需要重新确认", accepted: "已采纳", pending: "排队中", processing: "正在整理", ready: "已整理", failed: "暂未完成", unavailable: "暂不可用", sending: "发送中", sent: "已送达", retryable_failed: "可以重试", permanently_failed: "未能发送", needs_reconciliation: "发送结果待核对", support: "支持", conflict: "存在反例", extends: "补充条件", unknown: "尚待验证", context: "适用情境", active: "展示中", withdrawn: "已撤回", deleted: "已删除", published: "当前版本", superseded: "历史版本", live: "真实接口", replay: "演示回放" };
export const label = (value: string) => statusLabels[value] ?? value;
