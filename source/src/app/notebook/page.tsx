import type { Metadata } from "next";
import { LiveApp } from "@/components/live-app";
export const metadata: Metadata = { title: "看山的小本子 · 活答案" };
export default function Page() { return <LiveApp page="notebook" />; }
