import { permanentRedirect } from "next/navigation";

/** The opener tree moved to a tab of Strategies; an old link keeps its filters and open rows. */
export default async function OpenersPage({ searchParams }: PageProps<"/openers">) {
  const sp = await searchParams;
  const q = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => [v ?? []].flat().map((x): [string, string] => [k, x])));
  permanentRedirect(`/strategies/openers?${q}`);
}
