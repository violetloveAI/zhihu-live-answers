import { DomainError } from "../domain";

/** Operators can lower the shared allowance, never raise it beyond the documented limit. */
export function getPublicationPolicy(env: { PUBLISH_MAX_PER_HOUR?: string } = { PUBLISH_MAX_PER_HOUR: process.env.PUBLISH_MAX_PER_HOUR }) {
  const configured = env.PUBLISH_MAX_PER_HOUR?.trim();
  const limit = configured ? Number(configured) : 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new DomainError("publication_policy_invalid", "发送额度配置无效，维护者需设置每小时 1–5 条。", 503);
  }
  return { limit, windowMs: 3_600_000, window: "每小时" };
}
