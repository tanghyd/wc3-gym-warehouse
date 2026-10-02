import Link from "next/link";

/** The two tabs of Strategies, each a page; a tab keeps the race, opponent race, map and minutes. */
export function Tabs({ on, pairs }: { on: "named" | "openers"; pairs: [string, string][] }) {
  const q = new URLSearchParams(pairs).toString();
  return (
    <nav aria-label="Strategies" className="tabs">
      <Link href={`/strategies?${q}`} aria-current={on === "named" ? "page" : undefined}>
        Named
      </Link>
      <Link href={`/strategies/openers?${q}`} aria-current={on === "openers" ? "page" : undefined}>
        Openers
      </Link>
    </nav>
  );
}
