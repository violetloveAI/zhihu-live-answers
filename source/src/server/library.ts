import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { AppDb } from "@/db";
import { getTopicDetail, getTopicRecord, listTopics, withIdempotency } from "@/db/repository";
import * as t from "@/db/schema";
import { DomainError, requireRole, workspaceFor, type Actor, type experiencePreviewSchema } from "@/domain";
import { ReplayLLMProvider } from "@/providers/llm";
import { ReplayZhihuProvider } from "@/providers/zhihu";
import { AnswerService, audit } from "./services";

// This marker is deliberately permanent. A removed example is never replenished.
const markerRoute = "demo.library";
const markerKey = "initial-v1";
type DemoContribution = { slug: "ai-products" | "campus-ai"; input: z.infer<typeof experiencePreviewSchema> };
const examples: DemoContribution[] = [
  { slug: "ai-products", input: { contributionKind: "experience", displayMode: "nickname", text: "【演示样例 · 虚构情境】我没有编程经验，借助 AI 两天完成原型，可以展示三个核心页面。给朋友试用后却发现权限错误和保存失败，持续维护又花了一周。我能独立重现问题并逐项测试之后，才敢把它交给更多人使用；完成展示还不能代表产品已经稳定。" } },
  { slug: "ai-products", input: { contributionKind: "comment", displayMode: "anonymous", text: "【演示样例 · 虚构情境】建议先说明成功标准：完成原型、让朋友试用、持续维护三个月是不同目标。我的补充是把每次故障和修复测试记下来，再比较投入与结果，避免只用一个漂亮页面判断能力。" } },
  { slug: "campus-ai", input: { contributionKind: "experience", displayMode: "pseudonym", pseudonym: "练习中的小林", text: "【演示样例 · 虚构情境】我在课程里先用 AI 做解释与练习，再关闭工具，独立完成一道改了条件的新题。第一次仍然无法解释关键步骤，重新理解概念并记录错因后，才完成第二次验证。这让我把作业完成度和独立能力分开记录，没有把一次通过当作普遍效果。" } },
  { slug: "campus-ai", input: { contributionKind: "evidence", displayMode: "pseudonym", pseudonym: "资料收集员", sourceUrl: "https://docs.python.org/3/tutorial/", text: "【演示样例 · 虚构情境】这里附一个官方教程入口，演示怎样保存独立练习的参考链接。可以围绕课程目标选择小任务，记录使用工具前后的理解与测试结果。此链接仅作为待核对的参考入口，不能单独证明 AI 提高了学习效果，也没有替代课程规则。" } },
];

async function hasDemoMarker(db: AppDb, actor: Actor | null): Promise<boolean> {
  if (actor?.mode !== "replay") return false;
  const [marker] = await db.select({ id: t.idempotencyRecords.id }).from(t.idempotencyRecords).where(and(
    eq(t.idempotencyRecords.workspaceId, actor.workspaceId), eq(t.idempotencyRecords.actorId, actor.id),
    eq(t.idempotencyRecords.route, markerRoute), eq(t.idempotencyRecords.key, markerKey),
  )).limit(1);
  return Boolean(marker);
}

export async function getLibrary(db: AppDb, actor: Actor | null) {
  const workspaceId = workspaceFor(actor);
  const topics = await listTopics(db, workspaceId);
  return {
    topics: await Promise.all(topics.map(topic => getTopicDetail(db, workspaceId, topic.id, actor))),
    demoSeeded: await hasDemoMarker(db, actor),
  };
}
export type LibraryDetail = Awaited<ReturnType<typeof getLibrary>>;

export async function seedDemoLibrary(db: AppDb, actor: Actor): Promise<LibraryDetail> {
  requireRole(actor);
  if (actor.mode !== "replay") throw new DomainError("not_demo", "演示样例只能添加到独立演示空间。", 403);
  const [owner] = await db.select({ mode: t.users.providerMode, role: t.users.role, kind: t.workspaces.kind }).from(t.users)
    .innerJoin(t.workspaces, eq(t.users.workspaceId, t.workspaces.id))
    .where(and(eq(t.users.id, actor.id), eq(t.users.workspaceId, actor.workspaceId))).limit(1);
  if (owner?.mode !== "replay" || owner.kind !== "demo" || owner.role !== actor.role) {
    throw new DomainError("not_demo", "演示样例只能添加到当前身份的独立演示空间。", 403);
  }
  await withIdempotency(db, actor, markerRoute, markerKey, { version: 1 }, async tx => {
    // All nested service writes use this transaction; failed setup leaves no marker
    // or partial examples. Explicit replay providers cannot read live configuration.
    const service = new AnswerService(tx, actor, new ReplayZhihuProvider(), new ReplayLLMProvider());
    const revisionExperiences: string[] = [];
    for (const [index, example] of examples.entries()) {
      const topic = await getTopicRecord(tx, actor.workspaceId, example.slug);
      const preview = await service.previewExperience(topic.id, example.input);
      const saved = await service.submitExperience(topic.id, {
        ...example.input, publicText: preview.publicText, previewHash: preview.previewHash, confirmed: true,
      }, `demo-library-v1-${index}`);
      if (example.slug === "ai-products") revisionExperiences.push(saved.experience.id);
    }
    if (actor.role === "maintainer") {
      const topic = await getTopicRecord(tx, actor.workspaceId, "ai-products");
      const sources = await tx.select({ id: t.evidence.id }).from(t.evidence).where(and(
        eq(t.evidence.workspaceId, actor.workspaceId), eq(t.evidence.topicId, topic.id),
        inArray(t.evidence.experienceId, revisionExperiences), eq(t.evidence.visibility, "public"),
      ));
      await service.proposeRevision(topic.id, sources.map(source => source.id));
    }
    await audit(tx, actor, null, "demo.library_seeded", "workspace", actor.workspaceId, { scenarioId: markerKey, providerMode: "replay" });
    return { seeded: true };
  });
  return getLibrary(db, actor);
}
