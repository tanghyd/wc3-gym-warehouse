import Link from "next/link";
import { pickerValues, searchReplays } from "@/lib/api";
import { mss, PlayerName, RACES, Trophy } from "@/lib/ui";

const FIELDS = ["race", "opponent_race", "map", "player"] as const;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-40 flex-1 flex-col gap-1 text-sm">
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
  const filters = Object.fromEntries(FIELDS.filter((k) => value(k)).map((k) => [k, [value(k)]]));
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
        <div className="flex items-center gap-4">
          <button type="submit" className="btn">
            Search
          </button>
          {Object.keys(filters).length > 0 && <Link href="/">Clear</Link>}
        </div>
      </form>

      <section className="card mt-4 overflow-x-auto">
        {replays.length === 0 ? (
          <p className="p-8 text-center text-muted">No replay matches. Widen the filters.</p>
        ) : (
          <table className="w-full text-left [&_td]:px-4 [&_td]:py-2.5 [&_th]:px-4 [&_th]:py-2.5">
            <thead className="text-sm text-muted">
              <tr>
                <th className="hidden font-medium sm:table-cell">GNL</th>
                <th className="font-medium">Map</th>
                <th className="hidden font-medium sm:table-cell">Matchup</th>
                <th className="font-medium">Players</th>
                <th className="text-right font-medium">Length</th>
              </tr>
            </thead>
            <tbody>
              {replays.map((r) => (
                <tr key={r.replay_id} className="border-t align-top">
                  <td className="hidden whitespace-nowrap sm:table-cell">{r.gnl ? `S${r.gnl.series_id} G${r.gnl.game_no}` : ""}</td>
                  <td>
                    {/* no prefetch: it runs generateMetadata, a full replay read per row */}
                    <Link href={`/replays/${r.replay_id}`} prefetch={false} className="font-medium">
                      {r.map || "Unknown map"}
                    </Link>
                  </td>
                  <td className="hidden sm:table-cell">{r.matchup}</td>
                  <td>
                    <ul>
                      {[...r.players]
                        .sort((a, b) => a.player_id - b.player_id)
                        .map((p) => (
                          <li key={p.player_id} className="flex items-center gap-1.5">
                            <PlayerName name={p.name} race={p.race} />
                            {p.won && <Trophy className="text-win" label="Won" />}
                          </li>
                        ))}
                    </ul>
                  </td>
                  <td className="text-right">{mss(r.duration_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
