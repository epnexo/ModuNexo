import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { ReactNode } from "react";
import { brandName } from "../components/brand/brand-mark";
import { loadBrand } from "../server/brand";
import "./globals.css";

// The name in the tab comes from the saved profile, so it is read per request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const name = brandName((await loadBrand()).profile);
  return { title: { default: name, template: `%s - ${name}` }, description: "Module platform shell" };
}

// Runs before the first paint so the page never flashes the wrong theme. The key matches ThemeToggle's.
const THEME_SCRIPT = `try{var t=localStorage.getItem("modunexo.theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="light"}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
