"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const PAGES = [
  ["/", "Replays"],
  ["/openers", "Openers"],
] as const;

/** The app bar's pages; a replay belongs to Replays. A gold underline marks the current one. */
export function Nav() {
  const path = usePathname();
  return (
    <nav aria-label="Pages" className="order-last flex w-full gap-6 sm:order-none sm:w-auto">
      {PAGES.map(([href, label]) => {
        const on = href === "/" ? path === "/" || path.startsWith("/replays") : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={on ? "page" : undefined}
            className="flex h-11 items-center border-b-2 border-transparent text-on-surface hover:no-underline aria-[current=page]:border-primary aria-[current=page]:font-bold sm:h-14"
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
