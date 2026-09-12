import { assetPath } from "./runtime";
type Pose = "wave" | "working" | "idle" | "sway" | "sleep" | "play";
export function Kanshan({ pose = "idle", className = "", alt = "刘看山" }: { pose?: Pose; className?: string; alt?: string }) {
  return <picture className={`kanshan ${className}`}>
    <source media="(prefers-reduced-motion: reduce)" srcSet={assetPath(`/kanshan/${pose}.png`)} />
    {/* Official transparent animation, intentionally unoptimized to retain motion. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={assetPath(`/kanshan/${pose}.gif`)} alt={alt} width={320} height={320} />
  </picture>;
}
