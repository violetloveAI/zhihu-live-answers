import { createHash, createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  assertServer, circleInputSchema, ProviderError, publishInputSchema, publishReceiptSchema,
  searchInputSchema, sourceSnapshotSchema, validateInput,
  type CircleInput, type Provenance, type PublishInput, type PublishReceipt,
  type SearchInput, type SourceItem, type SourceSnapshot, type ZhihuProvider,
} from "./contracts";
export { ProviderError } from "./contracts";

const searchDataSchema = z.object({
  HasMore: z.boolean(), SearchHashId: z.string(), EmptyReason: z.string().optional(),
  Items: z.array(z.object({
    Title: z.string(), ContentType: z.string(), ContentID: z.string().min(1),
    ContentText: z.string(), Url: z.string(), AuthorName: z.string(), EditTime: z.number().finite(),
  })),
});
const hotDataSchema = z.object({
  Total: z.number().int().nonnegative(),
  Items: z.array(z.object({ Title: z.string(), Url: z.string(), ThumbnailUrl: z.string(), Summary: z.string() })),
});
const envelopeSchema = z.object({ Code: z.number(), Message: z.string().optional(), Data: z.unknown().optional() });
const circleRowSchema = z.object({
  content: z.string(), author_name: z.string().optional(), title: z.string().optional(),
  content_token: z.union([z.string().min(1), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String)]).optional(),
  comment_id: z.union([z.string().min(1), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String)]).optional(),
});
const circleEnvelopeSchema = z.object({ status: z.number().optional(), code: z.number().optional(), data: z.unknown().optional() });
const ringDataSchema = z.object({ contents: z.array(circleRowSchema), has_more: z.boolean().optional() });
const commentsDataSchema = z.object({ comments: z.array(circleRowSchema), has_more: z.boolean().optional() });
export const CIRCLE_PUBLICATION_TITLE = "活答案 · 刘看山的下一问";
/** Based on the inspected keepwonder client, not a claim of successful official API testing. */
export function signCircleRequest(appKey: string, appSecret: string, timestamp: string, logId: string): string {
  return createHmac("sha256", appSecret).update(`app_key:${appKey}|ts:${timestamp}|logid:${logId}|extra_info:`).digest("base64");
}
const limitSchema = z.object({ limit: z.number().int().min(1).max(30).optional() });

export function toPlainText(input: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, key: string) => {
      if (!key.startsWith("#")) return entities[key.toLowerCase()] ?? all;
      const value = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : "";
    }).replace(/\s+/g, " ").trim();
}
export function safeZhihuUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !(url.hostname === "zhihu.com" || url.hostname.endsWith(".zhihu.com"))) throw new Error();
    return url.toString();
  } catch { throw new ProviderError("invalid_response", "知乎返回了无法验证的来源链接。"); }
}
export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Math.min(86400000, Number(value) * 1000);
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.min(86400000, Math.max(0, milliseconds - now)) : undefined;
}
/** Canonical content fingerprint shared with the human-approved outbox. */
export function hashPublishPayload(input: { circleId: string; text: string }): string {
  return createHash("sha256").update(JSON.stringify({ circleId: input.circleId, text: input.text.trim() })).digest("hex");
}
function uniqueSources(items: SourceItem[]): SourceItem[] {
  return [...new Map(items.map((item) => [`${item.type}:${item.sourceId}`, item])).values()];
}

export interface LiveZhihuOptions {
  accessSecret?: string; timeoutMs?: number; fetch?: typeof fetch; now?: () => Date;
  circleAppKey?: string; circleAppSecret?: string; allowedCircleIds?: string[]; publishEnabled?: boolean;
  /** Server-verified published pins, never populated directly from untrusted request JSON. */
  knownPinsByCircle?: Record<string, string[]>; logId?: () => string;
}
export class LiveZhihuProvider implements ZhihuProvider {
  readonly mode = "live" as const;
  private readonly requestFetch: typeof fetch;
  private readonly now: () => Date;
  private readonly knownPins = new Map<string, Set<string>>();
  private readonly deliveries = new Map<string, { hash: string; promise: Promise<PublishReceipt> }>();
  private readonly publicationAttempts: number[] = [];
  constructor(private readonly options: LiveZhihuOptions = {}) {
    assertServer(); this.requestFetch = options.fetch ?? globalThis.fetch; this.now = options.now ?? (() => new Date());
    for (const [circle, pins] of Object.entries(options.knownPinsByCircle ?? {})) this.knownPins.set(circle, new Set(pins));
  }
  private provenance(requestId?: string): Provenance {
    return { provider: "zhihu", mode: this.mode, fetchedAt: this.now().toISOString(), requestId, sourceNature: "remote" };
  }
  private async get(path: string, query: Record<string, string>): Promise<unknown> {
    if (!this.options.accessSecret) throw new ProviderError("unconfigured", "知乎开放平台尚未配置。");
    const url = new URL(path, "https://developer.zhihu.com");
    url.search = new URLSearchParams(query).toString();
    let response: Response;
    try {
      response = await this.requestFetch(url, {
        method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000),
        headers: { Authorization: `Bearer ${this.options.accessSecret}`, "X-Request-Timestamp": String(Math.floor(this.now().getTime() / 1000)), "Content-Type": "application/json" },
      });
    } catch (error) {
      const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
      throw new ProviderError(timeout ? "timeout" : "unavailable", timeout ? "知乎请求超时，请稍后重试。" : "暂时无法连接知乎。", true);
    }
    const wait = retryAfterMilliseconds(response.headers.get("Retry-After"), this.now().getTime());
    if ([401, 403].includes(response.status)) throw new ProviderError("unauthorized", "知乎凭证或权限需要检查。");
    if (response.status === 429) throw new ProviderError("rate_limited", "知乎请求频率已达上限。", true, wait);
    if (!response.ok) throw new ProviderError("unavailable", "知乎服务暂时不可用。", response.status >= 500);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new ProviderError("invalid_response", "知乎返回了无法解析的数据。"); }
    const parsed = envelopeSchema.safeParse(payload);
    if (!parsed.success) throw new ProviderError("invalid_response", "知乎响应结构与文档不一致。");
    const { Code, Data } = parsed.data;
    if (Code === 0) return Data;
    if (Code === 10001) throw new ProviderError("invalid_response", "知乎拒绝了请求参数。");
    if (Code === 20001) throw new ProviderError("unauthorized", "知乎凭证或权限需要检查。");
    if (Code === 30001) throw new ProviderError("rate_limited", "知乎请求频率已达上限。", true, wait);
    if (Code === 30002) throw new ProviderError("rate_limited", "知乎可用额度不足，请检查平台配额。", false);
    throw new ProviderError("unavailable", "知乎暂未完成请求。", Code === 90001);
  }
  async searchTopics(input: SearchInput): Promise<SourceSnapshot> {
    const { query, limit = 10 } = validateInput(searchInputSchema, input);
    const parsed = searchDataSchema.safeParse(await this.get("/api/v1/content/zhihu_search", { Query: query, Count: String(limit) }));
    if (!parsed.success) throw new ProviderError("invalid_response", "知乎搜索结果结构与文档不一致。");
    const provenance = this.provenance(parsed.data.SearchHashId);
    return sourceSnapshotSchema.parse({
      provenance, emptyReason: parsed.data.EmptyReason,
      items: uniqueSources(parsed.data.Items.map((item) => ({
        sourceId: `${item.ContentType.toLowerCase()}:${item.ContentID}`, type: "search" as const,
        title: toPlainText(item.Title), summary: toPlainText(item.ContentText), url: safeZhihuUrl(item.Url),
        author: { displayName: toPlainText(item.AuthorName) }, provenance,
        publishedAt: item.EditTime > 0 && Number.isFinite(new Date(item.EditTime * 1000).getTime()) ? new Date(item.EditTime * 1000).toISOString() : undefined,
      }))),
    });
  }
  async hotList(input: { limit?: number } = {}): Promise<SourceSnapshot> {
    const { limit = 30 } = validateInput(limitSchema, input);
    const parsed = hotDataSchema.safeParse(await this.get("/api/v1/content/hot_list", { Limit: String(limit) }));
    if (!parsed.success) throw new ProviderError("invalid_response", "知乎热榜结果结构与文档不一致。");
    const provenance = this.provenance();
    return sourceSnapshotSchema.parse({
      provenance,
      items: uniqueSources(parsed.data.Items.map((item) => {
        const url = safeZhihuUrl(item.Url); const canonical = new URL(url); canonical.search = ""; canonical.hash = "";
        return {
          sourceId: `hot:${createHash("sha256").update(canonical.toString()).digest("hex").slice(0, 24)}`,
          type: "hot" as const, title: toPlainText(item.Title), summary: toPlainText(item.Summary), url, provenance,
        };
      })),
    });
  }
  private requireCircle(circleId: string): void {
    if (!(this.options.allowedCircleIds ?? []).includes(circleId)) throw new ProviderError("unauthorized", "该圈子不在应用已配置的授权范围内。");
    if (!this.options.circleAppKey || !this.options.circleAppSecret) throw new ProviderError("unconfigured", "知乎圈子凭证尚未配置。");
  }
  private async circleRequest(method: "GET" | "POST", path: string, values: Record<string, string | number>): Promise<unknown> {
    const timestamp = String(Math.floor(this.now().getTime() / 1000));
    const logId = this.options.logId?.() ?? randomUUID();
    const headers: Record<string, string> = {
      "X-App-Key": this.options.circleAppKey!, "X-Timestamp": timestamp, "X-Log-Id": logId,
      "X-Sign": signCircleRequest(this.options.circleAppKey!, this.options.circleAppSecret!, timestamp, logId),
    };
    const url = new URL(path, "https://openapi.zhihu.com");
    if (method === "GET") url.search = new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])).toString();
    else headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await this.requestFetch(url, {
        method, headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000),
        ...(method === "POST" ? { body: JSON.stringify(values) } : {}),
      });
    } catch (error) {
      if (method === "POST") throw new ProviderError("unknown_delivery", "未收到知乎发布回执。内容可能已送达，请先核对，勿重复发布。", false, undefined, logId);
      const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
      throw new ProviderError(timeout ? "timeout" : "unavailable", "暂时无法读取知乎圈子。", true, undefined, logId);
    }
    if ([401, 403].includes(response.status)) throw new ProviderError("unauthorized", "圈子凭证或授权范围需要检查。", false, undefined, logId);
    if (response.status === 429) throw new ProviderError("rate_limited", "圈子接口请求频率已达上限。", true, retryAfterMilliseconds(response.headers.get("Retry-After"), this.now().getTime()), logId);
    if (!response.ok) {
      if (method === "POST" && response.status >= 500) throw new ProviderError("unknown_delivery", "知乎发布结果暂不确定，请先核对远端内容。", false, undefined, logId);
      throw new ProviderError("unavailable", "知乎圈子暂未完成请求。", response.status >= 500, undefined, logId);
    }
    let payload: unknown;
    try { payload = await response.json(); } catch {
      throw new ProviderError(method === "POST" ? "unknown_delivery" : "invalid_response", "未能识别知乎圈子回执。", false, undefined, logId);
    }
    const parsed = circleEnvelopeSchema.safeParse(payload);
    if (!parsed.success || (parsed.data.status === undefined && parsed.data.code === undefined)) throw new ProviderError(method === "POST" ? "unknown_delivery" : "invalid_response", "圈子回执缺少明确状态。", false, undefined, logId);
    const codes = [parsed.data.status, parsed.data.code].filter((code) => code !== undefined);
    if (codes.every((code) => code === 0)) return parsed.data.data;
    if (codes.includes(101)) throw new ProviderError("unauthorized", "圈子签名或凭证校验失败。", false, undefined, logId);
    if (codes.includes(429)) throw new ProviderError("rate_limited", "圈子请求频率已达上限。", true, undefined, logId);
    // Conflicting 0/nonzero statuses or undocumented codes cannot prove POST failure.
    throw new ProviderError(method === "POST" ? "unknown_delivery" : "unavailable", "圈子响应未能确认操作结果。", false, undefined, logId);
  }
  async listCircleDiscussion(input: CircleInput): Promise<SourceSnapshot> {
    const parsed = validateInput(circleInputSchema, input); this.requireCircle(parsed.circleId);
    const page = parsed.cursor === undefined ? 1 : Number(parsed.cursor);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || (parsed.cursor && !/^\d+$/.test(parsed.cursor))) throw new ProviderError("invalid_response", "圈子分页参数无效。");
    // A circle allowlist must not become an arbitrary pin/comment access proxy.
    if (parsed.pinId && !this.knownPins.get(parsed.circleId)?.has(parsed.pinId)) {
      await this.listCircleDiscussion({ circleId: parsed.circleId });
      if (!this.knownPins.get(parsed.circleId)?.has(parsed.pinId)) throw new ProviderError("unauthorized", "该帖子尚未被验证属于已授权圈子。");
    }
    const raw = parsed.pinId
      ? await this.circleRequest("GET", "/openapi/comment/list", { content_type: "pin", content_token: parsed.pinId, page_num: page, page_size: 20 })
      : await this.circleRequest("GET", "/openapi/ring/detail", { ring_id: parsed.circleId, page_num: page, page_size: 20 });
    const data = parsed.pinId ? commentsDataSchema.safeParse(raw) : ringDataSchema.safeParse(raw);
    if (!data.success) throw new ProviderError("invalid_response", "圈子数据结构与已查阅的客户端契约不一致。");
    const rows = "comments" in data.data ? data.data.comments : data.data.contents;
    const provenance = this.provenance();
    const items = rows.map((row): SourceItem => {
      const remoteId = parsed.pinId ? row.comment_id : row.content_token;
      const sourceId = remoteId ? `${parsed.pinId ? "comment" : "pin"}:${remoteId}` : `content-hash:${createHash("sha256").update(JSON.stringify({ circleId: parsed.circleId, pinId: parsed.pinId, content: row.content, author: row.author_name })).digest("hex")}`;
      if (!parsed.pinId && remoteId) {
        const pins = this.knownPins.get(parsed.circleId) ?? new Set<string>(); pins.add(remoteId); this.knownPins.set(parsed.circleId, pins);
      }
      return {
        sourceId, type: parsed.pinId ? "circle_comment" : "circle_post", title: row.title ? toPlainText(row.title) : undefined,
        summary: toPlainText(row.content), author: row.author_name ? { displayName: toPlainText(row.author_name) } : undefined,
        // A comment without a documented permalink is linked only to its verified parent pin.
        url: parsed.pinId ? safeZhihuUrl(`https://www.zhihu.com/pin/${encodeURIComponent(parsed.pinId)}`) : remoteId ? safeZhihuUrl(`https://www.zhihu.com/pin/${encodeURIComponent(remoteId)}`) : undefined,
        provenance,
      };
    });
    return sourceSnapshotSchema.parse({ items: uniqueSources(items), provenance, nextCursor: data.data.has_more ? String(page + 1) : undefined });
  }
  async publishCircleQuestion(input: PublishInput): Promise<PublishReceipt> {
    const parsed = validateInput(publishInputSchema, input); this.requireCircle(parsed.circleId);
    if (!this.options.publishEnabled) throw new ProviderError("unconfigured", "尚未启用真实圈子发布。");
    if (hashPublishPayload(parsed) !== parsed.approvedPayloadHash) throw new ProviderError("unauthorized", "发布正文与已确认内容不一致，请重新确认。");
    const existing = this.deliveries.get(parsed.idempotencyKey);
    if (existing) {
      if (existing.hash !== parsed.approvedPayloadHash) throw new ProviderError("unauthorized", "同一发布任务不能替换已确认内容。");
      return existing.promise;
    }
    const now = this.now().getTime();
    while (this.publicationAttempts[0] <= now - 3600000) this.publicationAttempts.shift();
    if (this.publicationAttempts.length >= 5) throw new ProviderError("rate_limited", "发布次数已达每小时 5 条的应用保护上限。", true, this.publicationAttempts[0] + 3600000 - now);
    // Persistent cross-worker reservation is owned by the database outbox. This is a second local guard.
    this.publicationAttempts.push(now);
    const promise = this.sendPublication(parsed);
    this.deliveries.set(parsed.idempotencyKey, { hash: parsed.approvedPayloadHash, promise });
    try { return await promise; } catch (error) {
      // Definite rejection can be retried by the outbox. Unknown deliveries remain latched.
      if (error instanceof ProviderError && error.kind !== "unknown_delivery") this.deliveries.delete(parsed.idempotencyKey);
      throw error;
    }
  }
  private async sendPublication(input: PublishInput): Promise<PublishReceipt> {
    const raw = await this.circleRequest("POST", "/openapi/publish/pin", { ring_id: input.circleId, title: CIRCLE_PUBLICATION_TITLE, content: input.text });
    const data = z.object({ content_token: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String)]) }).safeParse(raw);
    if (!data.success) throw new ProviderError("unknown_delivery", "知乎已响应，但没有可核验的帖子 ID。请先核对远端，勿重复发布。");
    const provenance = this.provenance(); const pins = this.knownPins.get(input.circleId) ?? new Set<string>(); pins.add(data.data.content_token); this.knownPins.set(input.circleId, pins);
    return publishReceiptSchema.parse({ remoteId: data.data.content_token, url: `https://www.zhihu.com/pin/${data.data.content_token}`, sentAt: provenance.fetchedAt, mode: this.mode, provenance });
  }
}

const FIXTURE_TIME = "2026-09-07T00:00:00.000Z";
function replayProvenance(fetchedAt: string): Provenance {
  return { provider: "replay", mode: "replay", fetchedAt, snapshotId: "live-answers-demo-v1", sourceNature: "synthetic" };
}
export const demoSourceItems: SourceItem[] = [
  { sourceId: "replay:prototype-01", type: "search", title: "零基础借助 AI 完成展示原型（演示）", summary: "我用 AI 在一周内完成了可点击原型。它仅用于展示，没有接入真实支付、用户账号或长期维护。", author: { displayName: "演示贡献者小林" }, provenance: replayProvenance(FIXTURE_TIME) },
  { sourceId: "replay:production-02", type: "search", title: "产品上线之后才遇到的问题（演示）", summary: "上线后开始有真实用户，错误日志、数据备份与安全检查占了大部分时间。我需要先理解代码才能稳定修复故障。", author: { displayName: "演示贡献者阿禾" }, provenance: replayProvenance(FIXTURE_TIME) },
  { sourceId: "replay:hot-ai-learning", type: "hot", title: "学习编程时，如何判断自己真的理解了？（演示）", summary: "关注在新任务中独立排查错误、解释代码与验证结果的能力。", provenance: replayProvenance(FIXTURE_TIME) },
  { sourceId: "replay:comment-maintenance", type: "circle_comment", title: "关于持续维护的新回复（演示）", summary: "我的产品已经服务真实用户三个月。最初 AI 能帮我快速完成，但处理数据备份和权限漏洞时，我补学了基础知识并请人复核。", author: { displayName: "演示贡献者小远" }, provenance: replayProvenance(FIXTURE_TIME) },
];
export interface ReplayZhihuOptions { items?: SourceItem[]; now?: () => Date }
export class ReplayZhihuProvider implements ZhihuProvider {
  readonly mode = "replay" as const;
  constructor(private readonly options: ReplayZhihuOptions = {}) { assertServer(); }
  private snapshot(types: SourceItem["type"][], limit = 30): SourceSnapshot {
    const provenance = replayProvenance((this.options.now?.() ?? new Date()).toISOString());
    const items = uniqueSources(structuredClone(this.options.items ?? demoSourceItems).filter((item) => types.includes(item.type)).slice(0, limit)).map((item) => ({
      ...item,
      // Injected records are never falsely presented as current live responses.
      provenance: { ...provenance, sourceNature: item.provenance.sourceNature === "official_example" ? "official_example" as const : "synthetic" as const },
    }));
    return sourceSnapshotSchema.parse({ items, provenance });
  }
  async searchTopics(input: SearchInput): Promise<SourceSnapshot> {
    const parsed = validateInput(searchInputSchema, input); return this.snapshot(["search"], parsed.limit ?? 10);
  }
  async hotList(input: { limit?: number } = {}): Promise<SourceSnapshot> {
    const parsed = validateInput(limitSchema, input); return this.snapshot(["hot"], parsed.limit ?? 30);
  }
  async listCircleDiscussion(input: CircleInput): Promise<SourceSnapshot> {
    validateInput(circleInputSchema, input); return this.snapshot(["circle_post", "circle_comment"]);
  }
  async publishCircleQuestion(input: PublishInput): Promise<PublishReceipt> {
    const parsed = validateInput(publishInputSchema, input);
    if (hashPublishPayload(parsed) !== parsed.approvedPayloadHash) throw new ProviderError("unauthorized", "发布正文与已确认内容不一致，请重新确认。");
    const provenance = replayProvenance((this.options.now?.() ?? new Date()).toISOString());
    return publishReceiptSchema.parse({
      mode: this.mode, remoteId: `replay-${createHash("sha256").update(parsed.idempotencyKey).digest("hex").slice(0, 20)}`,
      sentAt: provenance.fetchedAt, provenance,
    });
  }
}
export function createZhihuProvider(options: { mode?: "live" | "replay"; env?: Record<string, string | undefined>; knownPinsByCircle?: Record<string, string[]> } = {}): ZhihuProvider {
  const env = options.env ?? process.env;
  const mode = options.mode ?? env.ZHIHU_MODE;
  if (mode === "live") return new LiveZhihuProvider({
    accessSecret: env.ZHIHU_ACCESS_SECRET, circleAppKey: env.ZHIHU_CIRCLE_APP_KEY, circleAppSecret: env.ZHIHU_CIRCLE_APP_SECRET,
    allowedCircleIds: (env.ZHIHU_CIRCLE_ALLOWED_IDS ?? env.ZHIHU_CIRCLE_ID ?? "").split(",").map((id) => id.trim()).filter(Boolean),
    publishEnabled: env.ZHIHU_PUBLISH_ENABLED === "true", knownPinsByCircle: options.knownPinsByCircle,
  });
  if (mode && mode !== "replay") throw new ProviderError("unconfigured", "知乎数据模式配置无效。");
  return new ReplayZhihuProvider();
}
