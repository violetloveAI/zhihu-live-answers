import { assetPath, browserDemo } from "./runtime";
type Pose = "wave" | "working" | "idle" | "sway" | "sleep" | "play";
export function Kanshan({ pose = "idle", className = "", alt = "刘看山" }: { pose?: Pose; className?: string; alt?: string }) {
  return <picture className={`kanshan ${className}`}>
    <source media="(prefers-reduced-motion: reduce)" srcSet={assetPath(`/kanshan/${pose}.png`)} />
    {/* Use the small official still in the public demo to keep first load light. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={assetPath(`/kanshan/${pose}.${browserDemo ? "png" : "gif"}`)} alt={alt} width={320} height={320} decoding="async" />
  </picture>;
}
