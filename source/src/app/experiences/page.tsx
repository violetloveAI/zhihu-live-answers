import type { Metadata } from "next";
import { LiveApp } from "@/components/live-app";
export const metadata: Metadata = { title: "我的经历 · 活答案" };
export default function Page() { return <LiveApp page="experiences" />; }
