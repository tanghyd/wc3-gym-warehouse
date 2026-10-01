import type { Metadata } from "next";
import { Cardo, Cinzel, Lato } from "next/font/google";
import Link from "next/link";
import { Nav } from "./Nav";
import { paletteStyle, THEME_SCRIPT } from "./palette";
import { ThemeSwitch } from "./ThemeSwitch";
import "./globals.css";

// Cinzel for page titles, Cardo for headings and names, Lato for body text and every figure
const title = Cinzel({ variable: "--font-cinzel", subsets: ["latin"], display: "swap", weight: ["700"] });
const heading = Cardo({ variable: "--font-cardo", subsets: ["latin"], display: "swap", weight: ["400", "700"] });
const sans = Lato({ variable: "--font-lato", subsets: ["latin"], display: "swap", weight: ["400", "700"] });

export const metadata: Metadata = {
  title: { default: "Gym Replays", template: "%s – Gym Replays" },
  description: "Warcraft III replays: builds, heroes, APM and chat.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${title.variable} ${heading.variable} ${sans.variable} antialiased`} suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: paletteStyle() }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh">
        <header className="border-b bg-surface">
          <div className="wrap flex min-h-14 flex-wrap items-center gap-x-8">
            <Link href="/" className="truncate font-title text-lg font-bold text-on-surface hover:no-underline">
              Gym Replays
            </Link>
            <Nav />
            <ThemeSwitch />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
