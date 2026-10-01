import Link from "next/link";
import { pickerValues, searchReplays } from "@/lib/api";
import { mss, PlayerName, RACES, Result } from "@/lib/ui";

const FIELDS = ["race", "opponent_race", "map", "player"] as const;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-36 flex-1 flex-col gap-1 text-sm">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

function RaceSelect({ name, value }: { name: string; value: string }) {
  return (
    <select name={name} defaultValue={value} className="field">
      <option value="">Any</option>
      {Object.entries(RACES).map(([id, [label]]) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
    </select>
  );
}

export default async function ReplaysPage({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const value = (k: string) => (typeof sp[k] === "string" ? sp[k] : "");
  // Filters apply to the focus player's row: race is his, opponent race the other side's.
  const filters: Record<string, string[] | { gte?: number; lte?: number }> = Object.fromEntries(
    FIELDS.filter((k) => value(k)).map((k) => [k, [value(k)]]),
  );
  // ?min= and ?max= are the game length in minutes, both ends included
  const [min, max] = [value("min"), value("max")].map((v) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined));
  if (min !== undefined || max !== undefined) filters.minutes = { gte: min, lte: max };
  const [replays, maps, players] = await Promise.all([searchReplays(filters), pickerValues("map"), pickerValues("player")]);

  return (
    <main className="wrap py-6">
      <h1>Replays</h1>

      <form className="card mt-4 flex flex-wrap items-end gap-3 p-4">
        <Field label="Race">
          <RaceSelect name="race" value={value("race")} />
        </Field>
        <Field label="Opponent race">
          <RaceSelect name="opponent_race" value={value("opponent_race")} />
        </Field>
        <Field label="Map">
          <select name="map" defaultValue={value("map")} className="field">
            <option value="">Any</option>
            {maps.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label="Player">
          <input name="player" list="players" defaultValue={value("player")} className="field" autoComplete="off" />
          <datalist id="players">
            {players.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
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
        <div className="flex items-center gap-4">
          <button type="submit" className="btn btn-gold">
            Search
          </button>
          {Object.keys(filters).length > 0 && <Link href="/">Clear</Link>}
        </div>
      </form>

      <section className="card mt-4">
        <div className="bar">
          <h2>Games</h2>
          <span className="chip bg-primary text-on-primary">{replays.length}</span>
        </div>
        {replays.length === 0 ? (
          <p className="p-8 text-center text-muted">No replay matches. Widen the filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="hidden sm:table-cell">GNL</th>
                  <th>Map</th>
                  <th className="hidden sm:table-cell">Matchup</th>
                  <th>Players</th>
                  <th className="hidden text-right sm:table-cell">Length</th>
                </tr>
              </thead>
              <tbody>
                {replays.map((r) => (
                  <tr key={r.replay_id} className="align-top">
                    <td className="hidden whitespace-nowrap sm:table-cell">{r.gnl ? `S${r.gnl.series_id} G${r.gnl.game_no}` : ""}</td>
                    <td>
                      {/* no prefetch: it runs generateMetadata, a full replay read per row */}
                      <Link href={`/replays/${r.replay_id}`} prefetch={false} className="block max-w-28 font-bold break-words sm:max-w-none">
                        {r.map || "Unknown map"}
                      </Link>
                      {/* a phone has no room for the Length column, so the length sits under the map */}
                      <span className="mt-0.5 block text-sm text-muted sm:hidden">{mss(r.duration_ms)}</span>
                    </td>
                    <td className="hidden sm:table-cell">{r.matchup}</td>
                    <td>
                      <ul className="flex flex-col gap-1">
                        {[...r.players]
                          .sort((a, b) => a.player_id - b.player_id)
                          .map((p) => (
                            <li key={p.player_id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                              <PlayerName name={p.name} race={p.race} className="max-w-48 sm:max-w-none" />
                              {p.won && <Result won />}
                            </li>
                          ))}
                      </ul>
                    </td>
                    <td className="hidden text-right sm:table-cell">{mss(r.duration_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
