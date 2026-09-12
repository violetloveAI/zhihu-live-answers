import type { Role } from "../domain";

/** Resolve authorization from a server-verified identity, never client-supplied role fields. */
export function currentUserRole(user: { providerMode: "live" | "replay"; providerSubject?: string | null; role: Role }): Role {
  if (user.providerMode === "replay") return user.role;
  const subject = user.providerSubject;
  const allowlist = (process.env.ZHIHU_MAINTAINER_IDS || "").split(",").map(id => id.trim()).filter(Boolean);
  return subject?.trim() && allowlist.includes(subject) ? "maintainer" : "contributor";
}
