import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "zumen editor web",
  description:
    "Chrome ブラウザ上で完結して動く、図面・表・テキストの AI エディター（zumen WASM + WebGPU + Sign in with ChatGPT）",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
