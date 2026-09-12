/** Public build-time flags only. Never put credentials in NEXT_PUBLIC variables. */
export const browserDemo = process.env.NEXT_PUBLIC_DEMO_STORAGE === "browser";
export function assetPath(path: string) {
  return `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
}
