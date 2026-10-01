import Link from "next/link";
import { type Filters, pickerValues, raceCounts, searchReplays, stepObjects } from "@/lib/api";
import { parseRaces, raceFilters } from "@/lib/races";
import { decodeSteps, KINDS } from "@/lib/steps";
import { Field, matchup, mss, ObjIcon, PlayerName, record, Result } from "@/lib/ui";
import { PlayerSlot } from "./PlayerSlot";

const OPENERS = ["opener_1", "opener_2", "opener_3", "opener_4", "opener_5", "opener_6"];
const RESULTS: Record<string, string> = { won: "win", lost: "loss" };
const LIMIT = 100; // games a search lists

export default async function ReplaysPage({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const value = (k: string) => (typeof sp[k] === "string" ? sp[k] : "");
  const [objects, maps, patches, players, counts] = await Promise.all([stepObjects(), pickerValues("map"), pickerValues("patch"), pickerValues("player"), raceCounts({})]);
  // race and opponent_race hold race values, such as NE or NE,RN
  const [race, oppRace] = [parseRaces(value("race")), parseRaces(value("opponent_race"))];
  const byCode = Object.fromEntries(objects.map((o) => [o.code, o]));
  // A step's code gives its kind; a code that is no step object drops out.
  const steps = (k: string) => decodeSteps(value(k)).filter((s) => byCode[s.code]);
  const apiSteps = (k: string) =>
    steps(k).map((s) => ({
      type: KINDS[byCode[s.code].kind][1],
      code: s.code,
      within_prev_s: s.within,
      from_min: s.from === null ? null : s.from / 60,
      to_min: s.to === null ? null : s.to / 60,
    }));
  // The opener prefix a row of /openers links here with: opener_1 to opener_k, no gap.
  const prefix = OPENERS.map(value);
  prefix.splice(prefix.indexOf("") < 0 ? 6 : prefix.indexOf(""));

  // Player 1 is the focus: the row whose result the table reports. Map, patch, length and opener ride on him.
  const filters: Filters = {};
  Object.assign(filters, raceFilters(race), raceFilters(oppRace, "opponent_race", "opponent_random"));
  for (const k of ["map", "patch", "player"]) if (value(k)) filters[k] = [value(k)];
  prefix.forEach((c, i) => (filters[OPENERS[i]] = [c]));
  if (value("opp_player")) filters.opponent = [value("opp_player")];
  if (RESULTS[value("result")]) filters.result = [RESULTS[value("result")]];
  // ?min= and ?max= are the game length in minutes, both ends included; the filter is on exact ms
  const [min, max] = [value("min"), value("max")].map((v) => (v && Number.isFinite(Number(v)) ? Number(v) * 60000 : undefined));
  if (min !== undefined || max !== undefined) filters.duration_ms = { gte: min, lte: max };
  // Player 2 is another player of the game: the focus's opponent, so each side names the other.
  const p2: Filters = {};
  Object.assign(p2, raceFilters(oppRace), raceFilters(race, "opponent_race", "opponent_random"));
  for (const [k, from] of [["player", "opp_player"], ["opponent", "player"]])
    if (value(from)) p2[k] = [value(from)];
  if (RESULTS[value("opp_result")]) p2.result = [RESULTS[value("opp_result")]];
  const p2Steps = apiSteps("opp_steps");
  const others = p2.result || p2Steps.length ? [{ filters: p2, steps: p2Steps }] : [];
  const p1Steps = apiSteps("steps");

  const answer = await searchReplays({ filters, steps: p1Steps, others, limit: LIMIT + 1 });
  const { sql, params, refused } = answer;
  // The API keeps the first LIMIT + 1 by replay id; the one past LIMIT only says that more exist.
  const more = answer.replays.length > LIMIT;
  const past = more ? answer.replays.map((r) => r.replay_id).sort().at(-1) : undefined;
  const replays = answer.replays.filter((r) => r.replay_id !== past);
  // with no condition on a player there is no focus, and players stay in slot order
  const focused = Object.keys(filters).some((k) => !["map", "patch", "duration_ms"].includes(k)) || p1Steps.length > 0 || others.length > 0;
  const won = replays.map((r) => r.players.find((p) => p.player_id === r.focus_player_id)?.won);
  const set = Object.values(sp).some((v) => v);
  const withoutOpener = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" && v && !OPENERS.includes(k) ? [[k, v]] : [])));

  return (
    <main className="wrap py-6">
      <h1>Replays</h1>

      {/* keyed by the query, so a link or Back redraws the fields from the URL */}
      <form key={JSON.stringify(sp)} className="mt-4 flex flex-col gap-4">
        <div className="card flex flex-wrap items-end gap-3 p-4">
          <Field label="Map">
            <select name="map" defaultValue={value("map")} className="field">
              <option value="">Any</option>
              {maps.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Patch">
            <select name="patch" defaultValue={value("patch")} className="field">
              <option value="">Any</option>
              {patches.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <div role="group" aria-labelledby="minutes" className="flex min-w-36 flex-1 flex-col gap-1 text-sm">
            <span id="minutes" className="text-muted">
              Minutes
            </span>
            <div className="flex items-center gap-2">
              <input name="min" type="number" min={0} step="any" inputMode="decimal" placeholder="from" aria-label="Minutes from" defaultValue={value("min")} className="field w-full" />
              <span aria-hidden className="text-muted">
                –
              </span>
              <input name="max" type="number" min={0} step="any" inputMode="decimal" placeholder="to" aria-label="Minutes to" defaultValue={value("max")} className="field w-full" />
            </div>
          </div>
          {prefix.length > 0 && (
            <div role="group" aria-labelledby="opener" className="flex flex-col gap-1 text-sm">
              <span id="opener" className="text-muted">
                Opener
              </span>
              <div className="flex h-[38px] items-center gap-1">
                {prefix.map((c, i) => (
                  <span key={i}>
                    <input type="hidden" name={OPENERS[i]} value={c} />
                    <ObjIcon code={c} objects={byCode} size={28} alt={byCode[c]?.name ?? c} />
                  </span>
                ))}
                <Link href={`/?${withoutOpener}`} className="ml-2">
                  Remove
                </Link>
              </div>
            </div>
          )}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <PlayerSlot n={1} race={race} counts={counts} name={value("player")} outcome={value("result")} steps={steps("steps")} objects={objects} />
          <PlayerSlot n={2} race={oppRace} counts={counts} name={value("opp_player")} outcome={value("opp_result")} steps={steps("opp_steps")} objects={objects} />
        </div>
        <div className="flex items-center justify-end gap-4">
          {set && <Link href="/">Clear</Link>}
          <button type="submit" className="btn btn-gold">
            Search
          </button>
        </div>
      </form>
      <datalist id="players">
        {players.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>

      <section className="card mt-4">
        <div className="bar">
          <h2>Games</h2>
          {!refused && <span className="chip bg-primary text-on-primary">{more ? `${LIMIT}+` : replays.length}</span>}
          {focused && replays.length > 0 && (
            <span className="text-sm">
              Player 1 record {record(won.filter((w) => w === true).length, won.filter((w) => w === false).length)}
            </span>
          )}
        </div>
        {more && <p className="border-b px-4 py-3 text-sm text-muted">Showing the first {LIMIT}. Narrow the filters to see the rest.</p>}
        {refused ? (
          <p role="alert" className="p-8 text-center">
            The API refused this search: {refused}
          </p>
        ) : replays.length === 0 ? (
          <p className="p-8 text-center text-muted">No replay matches. {p1Steps.length || p2Steps.length ? "Drop a step or widen the filters." : "Widen the filters."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Map</th>
                  <th className="hidden sm:table-cell">Matchup</th>
                  <th>Players</th>
                  {focused && <th className="hidden sm:table-cell">Player 1</th>}
                  <th className="hidden text-right sm:table-cell">Length</th>
                </tr>
              </thead>
              <tbody>
                {replays.map((r) => {
                  // the focus player first, then the rest by slot
                  const rank = (p: { player_id: number }) => (focused && p.player_id === r.focus_player_id ? -1 : p.player_id);
                  const players = [...r.players].sort((a, b) => rank(a) - rank(b));
                  const focus = r.players.find((p) => p.player_id === r.focus_player_id);
                  return (
                    <tr key={r.replay_id} className="align-top">
                      <td>
                        {/* no prefetch: it runs generateMetadata, a full replay read per row */}
                        <Link href={`/replays/${r.replay_id}`} prefetch={false} className="block max-w-28 font-bold break-words sm:max-w-none">
                          {r.map || "Unknown map"}
                        </Link>
                        {/* a phone has no room for the Length column, so the length sits under the map */}
                        <span className="mt-0.5 block text-sm text-muted sm:hidden">{mss(r.duration_ms)}</span>
                      </td>
                      <td className="hidden sm:table-cell">{matchup(players)}</td>
                      <td>
                        <ul className="flex flex-col gap-2">
                          {players.map((p) => (
                            <li key={p.player_id} className="flex min-w-0 flex-col gap-1">
                              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                <PlayerName name={p.name} race={p.race} className="max-w-48 sm:max-w-none" />
                                {p.won && <Result won />}
                              </div>
                              {/* his heroes in pick order, a quiet second line */}
                              {p.heroes.length > 0 && (
                                <ul aria-label="Heroes" className="flex flex-wrap gap-1">
                                  {p.heroes.map((h, i) => {
                                    const label = `${byCode[h.code]?.name ?? "Unknown hero"}, level ${h.final_level}`;
                                    return (
                                      <li key={i}>
                                        <ObjIcon code={h.code} objects={byCode} size={20} alt={label} title={label} />
                                      </li>
                                    );
                                  })}
                                </ul>
                              )}
                            </li>
                          ))}
                        </ul>
                      </td>
                      {focused && <td className="hidden sm:table-cell">{focus && focus.won !== null && <Result won={focus.won} />}</td>}
                      <td className="hidden text-right sm:table-cell">{mss(r.duration_ms)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {sql && (
          <details className="border-t">
            <summary className="cursor-pointer px-4 py-3 text-sm text-muted">Show SQL</summary>
            <pre className="overflow-x-auto px-4 pb-4 text-xs leading-relaxed">
              {sql + Object.entries(params).map(([k, v]) => `\n-- ${k} = ${v}`).join("")}
            </pre>
          </details>
        )}
      </section>
    </main>
  );
}
