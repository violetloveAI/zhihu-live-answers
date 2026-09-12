import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import { createDemoWorkspace } from "@/db/repository";
import { auditEvents, oauthStates, sessions, users, workspaces } from "@/db/schema";
import { demoLoginSchema, PUBLIC_WORKSPACE, type Actor } from "@/domain";
import { constantTimeEqual, encryptToken, hashToken, randomToken, SecurityConfigurationError, sessionSecret, validSecret } from "./crypto";
import { currentUserRole } from "./roles";

export type { Actor } from "@/domain";
export class AuthError extends Error {
  readonly retryable = false;
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = "AuthError"; }
}
export const SESSION_COOKIE = "la_session";
export const OAUTH_BINDING_COOKIE = "la_oauth_binding";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OAUTH_TTL_MS = 10 * 60 * 1000;

function cookieValue(request: Request, name: string): string | undefined {
  const values = (request.headers.get("cookie") || "").split(";").map(x => x.trim()).filter(x => x.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  try { return decodeURIComponent(values[0].slice(name.length + 1)); } catch { return undefined; }
}
async function readCookie(name: string, request?: Request): Promise<string | undefined> {
  if (request) return cookieValue(request, name);
  const { cookies } = await import("next/headers");
  return (await cookies()).get(name)?.value;
}
function cookieSecure(request: Request): boolean { return new URL(process.env.APP_BASE_URL || request.url).protocol === "https:"; }
export function setAuthCookie(response: Response, request: Request, name: string, value: string, expiresAt?: string) {
  const seconds = expiresAt ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)) : 0;
  response.headers.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${cookieSecure(request) ? "; Secure" : ""}`);
  response.headers.set("Cache-Control", "no-store");
}
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const base = process.env.APP_BASE_URL;
  if (process.env.NODE_ENV === "production" && !base) throw new AuthError("APP_ORIGIN_NOT_CONFIGURED", "请先配置应用的正式访问地址。", 503);
  let expected: string;
  try {
    const target = new URL(base || request.url);
    expected = target.origin;
    // Next may normalize a loopback request URL to localhost. Only an unconfigured
    // local development server may use its actual loopback Host; never forwarded headers.
    if (!base && process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(target.hostname)) {
      const host = request.headers.get("host");
      if (host && /^[A-Za-z0-9.\[\]:-]+$/.test(host)) {
        const localTarget = new URL(`${target.protocol}//${host}`);
        if (["localhost", "127.0.0.1", "[::1]"].includes(localTarget.hostname) && localTarget.port === target.port) expected = localTarget.origin;
      }
    }
  }
  catch { throw new AuthError("APP_ORIGIN_NOT_CONFIGURED", "应用访问地址无效。", 503); }
  if (!origin || origin === "null" || origin !== expected || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new AuthError("CSRF_ORIGIN_MISMATCH", "请从本应用页面重新执行这个操作。", 403);
  }
}
export function demoEnabled(): boolean { return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test" || process.env.ENABLE_DEMO === "true"; }

export async function getActor(request?: Request): Promise<Actor | null> {
  const token = await readCookie(SESSION_COOKIE, request);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  let idHash: string;
  try { idHash = await hashToken(token); } catch (error) { if (error instanceof SecurityConfigurationError) return null; throw error; }
  const { db } = await getDatabase();
  const now = new Date().toISOString();
  const [record] = await db.select({ user: users, session: sessions }).from(sessions).innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.idHash, idHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, now))).limit(1);
  if (!record || record.session.workspaceId !== record.user.workspaceId) return null;
  const user = record.user;
  if (user.providerMode === "live" && (user.workspaceId !== PUBLIC_WORKSPACE || !user.providerSubject || !user.encryptedAccessToken || !user.tokenExpiresAt || new Date(user.tokenExpiresAt).getTime() <= Date.now())) return null;
  if ((user.providerMode === "replay" && (!demoEnabled() || user.workspaceId === PUBLIC_WORKSPACE || user.workspaceId === "preview")) || user.workspaceId === "preview") return null;
  const role = currentUserRole(user);
  return { id: user.id, workspaceId: user.workspaceId, mode: user.providerMode, role, displayName: user.displayName, avatarUrl: user.avatarUrl || undefined };
}
export async function requireActor(request?: Request): Promise<Actor> {
  await sessionSecret();
  const actor = await getActor(request);
  if (!actor) throw new AuthError("UNAUTHENTICATED", "请先登录，再记录这条经验。", 401);
  return actor;
}
export async function requireMaintainer(request?: Request): Promise<Actor> {
  const actor = await requireActor(request);
  if (actor.role !== "maintainer") throw new AuthError("FORBIDDEN", "只有维护者可以审核这个操作。", 403);
  return actor;
}
export function assertLiveActor(actor: Actor): void {
  if (actor.mode !== "live" || actor.workspaceId !== PUBLIC_WORKSPACE) throw new AuthError("DEMO_LIVE_FORBIDDEN", "演示身份不能向真实知乎社区发布内容。", 403);
}

async function issueSession(user: { id: string; workspaceId: string }, expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()) {
  const token = randomToken();
  const { db } = await getDatabase();
  await db.insert(sessions).values({ idHash: await hashToken(token), userId: user.id, workspaceId: user.workspaceId, expiresAt, createdAt: new Date().toISOString(), revokedAt: null });
  return { token, expiresAt };
}
export async function createDemoSession(input: unknown, request: Request) {
  assertSameOrigin(request);
  if (!demoEnabled()) throw new AuthError("DEMO_DISABLED", "这个环境未开放演示身份。", 403);
  await sessionSecret();
  const { role } = demoLoginSchema.parse(input);
  const workspaceId = await createDemoWorkspace();
  const user = { id: randomUUID(), workspaceId, providerMode: "replay" as const, providerSubject: null, displayName: role === "maintainer" ? "演示维护者" : "演示贡献者", role, createdAt: new Date().toISOString() };
  const { db } = await getDatabase();
  await db.insert(users).values(user);
  await db.insert(auditEvents).values({ workspaceId, actorId: user.id, actorMode: "replay", type: "auth.demo_session_created", entityType: "user", entityId: user.id, payloadSummary: { providerMode: "replay" } });
  await revokeSession(request);
  const session = await issueSession(user);
  const actor: Actor = { id: user.id, displayName: user.displayName, role, mode: "replay", workspaceId };
  return { actor, ...session };
}
export async function revokeSession(request: Request): Promise<void> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  const { db } = await getDatabase();
  const idHash = await hashToken(token);
  await db.transaction(async tx => {
    const [session] = await tx.select().from(sessions).where(and(eq(sessions.idHash, idHash), isNull(sessions.revokedAt))).limit(1);
    if (!session) return;
    const now = new Date().toISOString();
    await tx.update(sessions).set({ revokedAt: now }).where(eq(sessions.userId, session.userId));
    await tx.update(users).set({ encryptedAccessToken: null, encryptedRefreshToken: null, tokenExpiresAt: null }).where(eq(users.id, session.userId));
    const [user] = await tx.select().from(users).where(eq(users.id, session.userId)).limit(1);
    if (user) await tx.insert(auditEvents).values({ workspaceId: user.workspaceId, actorId: user.id, actorMode: user.providerMode, type: "auth.local_session_revoked", entityType: "user", entityId: user.id, payloadSummary: { status: "revoked" } });
  });
}

function oauthConfig() {
  const appId = process.env.ZHIHU_OAUTH_APP_ID, appKey = process.env.ZHIHU_OAUTH_APP_KEY, redirectUri = process.env.ZHIHU_OAUTH_REDIRECT_URI;
  if (!appId || !appKey || !redirectUri) throw new AuthError("OAUTH_UNCONFIGURED", "知乎登录尚未配置，当前可以使用明确标记的演示身份。", 503);
  let redirect: URL;
  try { redirect = new URL(redirectUri); } catch { throw new AuthError("OAUTH_REDIRECT_INVALID", "知乎授权回调地址配置无效。", 503); }
  if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== "/api/auth/zhihu/callback") throw new AuthError("OAUTH_REDIRECT_INVALID", "知乎授权需要已登记的 HTTPS 回调地址。", 503);
  if (!process.env.APP_BASE_URL || redirect.origin !== new URL(process.env.APP_BASE_URL).origin) throw new AuthError("OAUTH_REDIRECT_INVALID", "知乎回调地址需要与应用正式地址一致。", 503);
  return { appId, appKey, redirectUri };
}
export async function beginZhihuOAuth(request: Request) {
  await sessionSecret();
  const config = oauthConfig();
  const state = randomToken(), binding = randomToken();
  const requestedReturn = new URL(request.url).searchParams.get("returnTo") || "/";
  const returnTo = /^\/(?!\/)/.test(requestedReturn) && !/[\\\r\n]/.test(requestedReturn) ? requestedReturn : "/";
  const expiresAt = new Date(Date.now() + OAUTH_TTL_MS).toISOString();
  const { db } = await getDatabase();
  await db.insert(oauthStates).values({ idHash: await hashToken(state, "oauth-state"), browserBindingHash: await hashToken(binding, "oauth-binding"), returnTo, expiresAt, createdAt: new Date().toISOString(), consumedAt: null });
  const redirect = new URL("https://openapi.zhihu.com/authorize");
  redirect.search = new URLSearchParams({ redirect_uri: config.redirectUri, app_id: config.appId, response_type: "code", state }).toString();
  return { redirect: redirect.toString(), binding, expiresAt };
}
export function parseOAuthCallback(url: URL): { state: string; code: string } {
  for (const key of ["state", "authorization_code", "code", "error"]) if (url.searchParams.getAll(key).length > 1) throw new AuthError("OAUTH_DUPLICATE_PARAMETER", "知乎回调包含重复参数，请重新登录。");
  const state = url.searchParams.get("state");
  if (!state) throw new AuthError("OAUTH_STATE_MISSING", "知乎未返回登录校验信息，请重试或联系维护者。", 403);
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new AuthError("OAUTH_STATE_INVALID", "登录校验信息不匹配，请重新登录。", 403);
  if (url.searchParams.has("error")) throw new AuthError("OAUTH_AUTHORIZATION_DECLINED", "知乎授权未完成，请重新登录。", 403);
  const primary = url.searchParams.get("authorization_code"), alternate = url.searchParams.get("code");
  if (primary !== null && alternate !== null && primary !== alternate) throw new AuthError("OAUTH_CODE_CONFLICT", "知乎回调授权码不一致，请重新登录。");
  const code = primary || alternate;
  if (!code || code.length > 4096) throw new AuthError("OAUTH_CODE_MISSING", "知乎回调没有有效授权码，请重新登录。");
  return { state, code };
}
async function consumeOAuthState(state: string, binding: string | undefined) {
  if (!binding || !/^[A-Za-z0-9_-]{43}$/.test(binding)) throw new AuthError("OAUTH_BROWSER_BINDING_MISSING", "请在发起知乎登录的浏览器中完成授权。", 403);
  const idHash = await hashToken(state, "oauth-state"), bindingHash = await hashToken(binding, "oauth-binding");
  const now = new Date().toISOString();
  const { db } = await getDatabase();
  return db.transaction(async tx => {
    const [pending] = await tx.select().from(oauthStates).where(eq(oauthStates.idHash, idHash)).limit(1);
    if (!pending || !constantTimeEqual(pending.browserBindingHash, bindingHash) || new Date(pending.expiresAt).getTime() <= Date.now() || pending.consumedAt) throw new AuthError("OAUTH_STATE_INVALID", "登录校验已失效或不匹配，请重新登录。", 403);
    const changed = await tx.update(oauthStates).set({ consumedAt: now }).where(and(eq(oauthStates.idHash, idHash), isNull(oauthStates.consumedAt), gt(oauthStates.expiresAt, now))).returning({ idHash: oauthStates.idHash });
    if (changed.length !== 1) throw new AuthError("OAUTH_STATE_REUSED", "这次登录校验已使用，请重新登录。", 403);
    return pending;
  });
}

const tokenSchema = z.object({ access_token: z.string().min(1).max(16384), token_type: z.string().refine(v => v.toLowerCase() === "bearer"), expires_in: z.number().finite().positive().max(365 * 24 * 3600) });
export function parseTokenResponse(input: unknown) {
  if (!input || typeof input !== "object") throw new AuthError("OAUTH_TOKEN_INVALID", "知乎返回的授权信息无法校验。", 502);
  const object = input as Record<string, unknown>;
  const businessCode = object.code ?? object.Code;
  if (businessCode !== undefined && businessCode !== 0 && businessCode !== 20000) throw new AuthError("OAUTH_TOKEN_REJECTED", "知乎未接受这次授权，请重新登录。", 502);
  const parsed = tokenSchema.safeParse(object.data ?? object.Data ?? object);
  if (!parsed.success) throw new AuthError("OAUTH_TOKEN_INVALID", "知乎返回的授权信息无法校验。", 502);
  return parsed.data;
}
export async function exchangeAuthorizationCode(code: string, fetcher: typeof fetch = fetch) {
  const config = oauthConfig();
  let response: Response;
  try {
    response = await fetcher("https://openapi.zhihu.com/access_token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ app_id: config.appId, app_key: config.appKey, grant_type: "authorization_code", redirect_uri: config.redirectUri, code }), redirect: "error", signal: AbortSignal.timeout(15000), cache: "no-store" });
  } catch { throw new AuthError("OAUTH_TOKEN_UNAVAILABLE", "暂时无法完成知乎授权，请稍后重试。", 502); }
  if (!response.ok) throw new AuthError("OAUTH_TOKEN_REJECTED", "知乎未接受这次授权，请重新登录。", 502);
  let body: unknown;
  try { body = await response.json(); } catch { throw new AuthError("OAUTH_TOKEN_INVALID", "知乎返回的授权信息无法校验。", 502); }
  return parseTokenResponse(body);
}

function profileConfig() {
  const url = process.env.ZHIHU_OAUTH_PROFILE_URL, subjectField = process.env.ZHIHU_OAUTH_SUBJECT_FIELD, displayNameField = process.env.ZHIHU_OAUTH_DISPLAY_NAME_FIELD;
  if (!url || !subjectField || !displayNameField) throw new AuthError("PROFILE_CONTRACT_PENDING", "知乎的账号标识协议尚待平台确认，目前不会创建正式登录身份。", 503);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new AuthError("PROFILE_CONFIG_INVALID", "知乎账号资料接口配置无效。", 503); }
  const safePath = (field: string) => /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(field) && !field.split(".").some(x => ["__proto__", "prototype", "constructor"].includes(x));
  if (parsed.protocol !== "https:" || parsed.hostname !== "openapi.zhihu.com" || parsed.username || parsed.password || parsed.port || parsed.hash || parsed.search || !safePath(subjectField) || !safePath(displayNameField) || subjectField === displayNameField) throw new AuthError("PROFILE_CONFIG_INVALID", "知乎账号资料协议必须使用平台确认的官方 HTTPS 地址与独立标识字段。", 503);
  return { url: parsed.toString(), subjectField, displayNameField };
}
function fieldAt(input: unknown, field: string): unknown {
  let value = input;
  for (const part of field.split(".")) {
    if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
export function validateZhihuProfile(input: unknown, subjectField: string, displayNameField: string) {
  const subject = fieldAt(input, subjectField), displayName = fieldAt(input, displayNameField);
  const parsed = z.object({ subject: z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9_.:-]+$/), displayName: z.string().trim().min(1).max(120) }).safeParse({ subject, displayName });
  if (!parsed.success || subjectField === displayNameField) throw new AuthError("PROFILE_IDENTITY_INVALID", "知乎没有返回经过确认的稳定账号标识，未创建登录身份。", 502);
  return parsed.data;
}
export async function fetchZhihuProfile(accessToken: string, fetcher: typeof fetch = fetch) {
  const config = profileConfig();
  const accessSecret = process.env.ZHIHU_ACCESS_SECRET;
  if (!accessSecret) throw new AuthError("PROFILE_AUTH_UNCONFIGURED", "知乎账号资料读取权限尚未配置。", 503);
  let response: Response;
  try { response = await fetcher(config.url, { headers: { Authorization: `Bearer ${accessSecret}`, "X-OAuth-Token": accessToken, "X-Request-Timestamp": String(Math.floor(Date.now() / 1000)) }, redirect: "error", signal: AbortSignal.timeout(15000), cache: "no-store" }); }
  catch { throw new AuthError("PROFILE_UNAVAILABLE", "暂时无法校验知乎账号身份，请稍后重试。", 502); }
  if (!response.ok) throw new AuthError("PROFILE_UNAVAILABLE", "暂时无法校验知乎账号身份，请稍后重试。", 502);
  let body: unknown;
  try { body = await response.json(); } catch { throw new AuthError("PROFILE_IDENTITY_INVALID", "知乎返回的账号资料无法校验。", 502); }
  if (body && typeof body === "object") { const b = body as Record<string, unknown>; const code = b.code ?? b.Code; if (code !== undefined && code !== 0 && code !== 20000) throw new AuthError("PROFILE_REJECTED", "知乎账号资料读取未成功。", 502); }
  return validateZhihuProfile(body, config.subjectField, config.displayNameField);
}
export async function completeZhihuOAuth(request: Request) {
  await sessionSecret();
  const { state, code } = parseOAuthCallback(new URL(request.url));
  const pending = await consumeOAuthState(state, cookieValue(request, OAUTH_BINDING_COOKIE));
  // Refuse an unsupported profile contract before exchanging a short-lived code.
  profileConfig();
  const token = await exchangeAuthorizationCode(code);
  const profile = await fetchZhihuProfile(token.access_token);
  await revokeSession(request);
  const { db } = await getDatabase();
  const now = new Date().toISOString(), tokenExpiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
  const role = currentUserRole({ providerMode: "live", providerSubject: profile.subject, role: "contributor" });
  const user = await db.transaction(async tx => {
    await tx.insert(workspaces).values({ id: PUBLIC_WORKSPACE, kind: "live", createdAt: now }).onConflictDoNothing();
    const [existing] = await tx.select().from(users).where(and(eq(users.providerMode, "live"), eq(users.providerSubject, profile.subject))).limit(1);
    const id = existing?.id || randomUUID();
    const encryptedAccessToken = await encryptToken(token.access_token, `zhihu-user:${id}`);
    if (existing) await tx.update(users).set({ displayName: profile.displayName, role, encryptedAccessToken, tokenExpiresAt }).where(eq(users.id, id));
    else await tx.insert(users).values({ id, workspaceId: PUBLIC_WORKSPACE, providerMode: "live", providerSubject: profile.subject, displayName: profile.displayName, role, encryptedAccessToken, tokenExpiresAt, createdAt: now });
    await tx.update(sessions).set({ revokedAt: now }).where(eq(sessions.userId, id));
    await tx.insert(auditEvents).values({ workspaceId: PUBLIC_WORKSPACE, actorId: id, actorMode: "live", type: "auth.zhihu_authorized", entityType: "user", entityId: id, payloadSummary: { providerMode: "live" } });
    return { id, workspaceId: PUBLIC_WORKSPACE };
  });
  const session = await issueSession(user, new Date(Math.min(Date.now() + SESSION_TTL_MS, new Date(tokenExpiresAt).getTime())).toISOString());
  return { ...session, returnTo: pending.returnTo };
}
export async function getAuthCapabilities() {
  let protectedWrites = false;
  try { await sessionSecret(); protectedWrites = true; } catch { /* Public reads remain available. */ }
  let oauthConfigured = false, profileConfigured = false;
  try { oauthConfig(); oauthConfigured = true; } catch { /* Only expose a boolean. */ }
  try { profileConfig(); profileConfigured = Boolean(process.env.ZHIHU_ACCESS_SECRET); } catch { /* No guessed identity schema. */ }
  const encryptionConfigured = validSecret(process.env.TOKEN_ENCRYPTION_KEY) || (process.env.NODE_ENV !== "production" && !process.env.TOKEN_ENCRYPTION_KEY);
  return { demo: demoEnabled() && protectedWrites, protectedWrites, zhihuOAuth: { configured: oauthConfigured, profileConfigured, encryptionConfigured, available: protectedWrites && oauthConfigured && profileConfigured && encryptionConfigured, status: !oauthConfigured ? "unconfigured" : !profileConfigured ? "profile_contract_pending" : !encryptionConfigured ? "encryption_not_configured" : "requires_verified_callback" }, externalPublishingRequiresLiveIdentity: true };
}

export function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthError || error instanceof SecurityConfigurationError) return Response.json({ error: { code: error.code, message: error.message, retryable: false } }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: { code: "INVALID_INPUT", message: "请检查提交的内容后重试。", retryable: false } }, { status: 400, headers: { "Cache-Control": "no-store" } });
  return Response.json({ error: { code: "AUTH_UNAVAILABLE", message: "登录服务暂时不可用，请稍后重试。", retryable: true } }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
