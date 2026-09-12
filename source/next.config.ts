import type { NextConfig } from "next";
const config: NextConfig = {
  output: "export", basePath: "/zhihu-live-answers", trailingSlash: true,
  images: { unoptimized: true }, poweredByHeader: false,
  env: { NEXT_PUBLIC_DEMO_STORAGE: "browser", NEXT_PUBLIC_BASE_PATH: "/zhihu-live-answers" },
};
export default config;
