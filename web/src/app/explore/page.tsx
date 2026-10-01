import type { Metadata } from "next";
import { getCatalog, queryWithSql, raceCounts, valueLabels } from "@/lib/api";
import { andList, chartOf, dimsOf, queryMeasures, RACE_DIMS, readView, type Row, titleCase, viewFilters } from "@/lib/explore";
import { raceValue } from "@/lib/races";
import { Query, Shell } from "./Query";
import { Result } from "./Result";

export const metadata: Metadata = { title: "Explore" };

const LIMIT = 10000; // rows POST /query answers at most

export default async function ExplorePage({ searchParams }: PageProps<"/explore">) {
  const [sp, cat] = await Promise.all([searchParams, getCatalog()]);
  const view = readView(sp, cat);
  const dims = dimsOf(view);
  const filters = viewFilters(view);
  // a race dimension reads its flag too, so a row names a race value such as RN
  const dimensions = dims.flatMap((d) => (RACE_DIMS[d] ? [d, RACE_DIMS[d]] : [d]));
  const scope = Object.fromEntries(Object.entries(filters).filter(([k]) => !["race", "random", "opponent_race", "opponent_random"].includes(k)));
  const [answer, counts] = await Promise.all([
    queryWithSql<Row>({ dimensions, measures: queryMeasures(view, cat), filters, limit: LIMIT }),
    raceCounts(scope),
  ]);
  const rows = answer.rows.map((r) => {
    const out: Row = { ...r };
    for (const [d, flag] of Object.entries(RACE_DIMS))
      if (d in out) {
        out[d] = raceValue(String(out[d]), Number(out[flag]));
        delete out[flag];
      }
    for (const d of dims) out[d] = String(out[d]);
    return out;
  });
  // the words and icons of every value on screen: the rows' and the checked filters'
  const seen: Record<string, Set<string>> = {};
  for (const d of [...dims, ...Object.keys(view.lists)]) seen[d] = new Set([...rows.flatMap((r) => (d in r ? [String(r[d])] : [])), ...(view.lists[d] ?? [])]);
  const labels = await valueLabels(Object.fromEntries(Object.entries(seen).map(([d, s]) => [d, [...s]])));
  const chart = chartOf(view, cat);
  const head = cat.labels[chart.measure ?? view.show[0]];
  const title = dims.length ? `${titleCase(head)} by ${andList(dims.map((d) => titleCase(cat.labels[d])))}` : andList(view.show.map((m) => titleCase(cat.labels[m])));

  return (
    <main className="wrap flex flex-col gap-4 py-6">
      <h1>Explore</h1>
      <Shell>
        <Query view={view} cat={cat} counts={counts} labels={labels} filters={filters} />
        <Result
          view={view}
          cat={cat}
          rows={rows}
          labels={labels}
          title={title}
          chart={chart}
          truncated={answer.rows.length >= LIMIT}
          sql={answer.sql + Object.entries(answer.params).map(([k, v]) => `\n-- ${k} = ${v}`).join("")}
        />
      </Shell>
    </main>
  );
}
