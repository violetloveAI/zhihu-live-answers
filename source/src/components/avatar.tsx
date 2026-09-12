"use client";
import { useEffect, useState } from "react";

/** Only a reviewed public avatar reaches this component; anonymous contributions pass no URL. */
export function Avatar({ name, url, tone = "mint" }: { name: string; url?: string | null; tone?: "mint" | "peach" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return <span className={`mini-avatar ${tone}`}>
    {url && !failed ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : name.slice(0, 1)}
  </span>;
}
