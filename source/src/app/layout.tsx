import type { Metadata } from "next";
import "./globals.css";
import "./live.css";

export const metadata: Metadata = {
  title: "活答案 · 和看山一起，把问题再想深一点",
  description: "真实经历，有据可循。和刘看山一起发现下一问，让答案随着新的经验继续生长。"
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
