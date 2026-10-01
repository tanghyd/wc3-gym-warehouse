import type { Metadata } from "next";
import { Alegreya, Alegreya_Sans } from "next/font/google";
import Link from "next/link";
import { paletteStyle, THEME_SCRIPT } from "./palette";
import { ThemeSwitch } from "./ThemeSwitch";
import "./globals.css";

const display = Alegreya({ variable: "--font-display", subsets: ["latin"], display: "swap", weight: ["700", "800"] });
const sans = Alegreya_Sans({ variable: "--font-body", subsets: ["latin"], display: "swap", weight: ["400", "500", "700"] });

export const metadata: Metadata = {
  title: { default: "GNL Replays", template: "%s – GNL Replays" },
  description: "Gym Newbie League replays: builds, heroes, APM and chat.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} antialiased`} suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: paletteStyle() }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh">
        <header className="border-b bg-surface">
          <div className="wrap flex min-h-14 items-center gap-4">
            <Link href="/" className="font-heading text-xl font-extrabold text-on-surface no-underline hover:text-on-surface">
              GNL Replays
            </Link>
            <ThemeSwitch />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
