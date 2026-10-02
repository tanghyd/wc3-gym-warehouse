import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { type GameEvent, getObjects, getReplay, type ReplayPlayer, stepGroups } from "@/lib/api";
import { type Hit, matchSide } from "@/lib/marks";
import { parseRaces } from "@/lib/races";
import { apiStep, countWords, decodeGroups, kindWord, played, stepObject, timeWords } from "@/lib/steps";
import { matchup, mss, ObjIcon, PlayerName, Result, SeriesKey, SkillTrail, Timer } from "@/lib/ui";
import { GameTimeline } from "./GameTimeline";

export async function generateMetadata({ params }: PageProps<"/replays/[id]">): Promise<Metadata> {
  const r = await getReplay((await params).id);
  return { title: r ? r.map || "Unknown map" : "No game with this id" };
}

/** One side of the search on this game: its player, the steps of the group that holds, and the orders they matched. */
type SideMarks = { title: string; player: ReplayPlayer; steps: { n: number; words: string; time: string; negate: boolean; hits: Hit[] }[]; held: boolean };

/**
 * The search a game was opened from (`q`, the Replays URL's query) read on this game: the Player
 * is the player named `side`, the Opponent the other one. Each side's steps match his orders as
 * POST /search reads them, so the timeline can mark them.
 */
async function searchMarks(q: string, side: string, players: ReplayPlayer[], events: GameEvent[]): Promise<SideMarks[]> {
  const search = new URLSearchParams(q);
  const me = players.find((p) => p.name === side);
  const other = me && players.find((p) => p.team_id !== me.team_id);
  const sides = [
    { title: "Player", player: me, race: parseRaces(search.get("race") ?? ""), groups: decodeGroups(search.get("steps") ?? "") },
    { title: "Opponent", player: other, race: parseRaces(search.get("opponent_race") ?? ""), groups: decodeGroups(search.get("opp_steps") ?? "") },
  ].filter((s) => s.player && s.groups.length);
  const all = sides.flatMap((s) => s.groups.flat());
  const keys = [...new Map(all.flatMap((s) => s.codes.filter((c) => c.startsWith("@")).map((c) => [`${s.kind}${c}`, { kind: s.kind, source: c.slice(1) }]))).values()];
  const groups = await stepGroups(keys);
  const names = await getObjects([...new Set([...all.flatMap((s) => s.codes.filter((c) => !c.startsWith("@"))), "htow", "ogre", "etol", "unpl"])]);
  const groupCodes = Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, g.codes]));
  return sides.map((s) => {
    const player = s.player!;
    // the heroes in pick order, as player_games.heroes lists them: a hero with no code is left out
    const heroes = [...player.heroes].sort((a, b) => a.slot - b.slot).map((h) => h.code).filter(Boolean);
    const mine = events.filter((e) => e.player_id === player.player_id);
    const match = matchSide(
      s.groups.map((g) => g.map((st) => apiStep(st, played(s.race), groupCodes))),
      mine,
      heroes,
    );
    const steps = s.groups[match?.group ?? 0].map((st, i) => {
      const hits = match?.hits.filter((h) => h.n === i + 1) ?? [];
      const words = [`${kindWord(st)} ${stepObject(st, s.race, names, groups).name}${countWords(st)}`, timeWords(st), st.before ? `before step ${st.before}` : ""].filter(Boolean).join(" ");
      const time = hits.length ? (hits.length > 1 ? `${mss(hits[0].time_ms)} to ${mss(hits[hits.length - 1].time_ms)}` : mss(hits[0].time_ms)) : "";
      return { n: i + 1, words, time, negate: st.negate, hits };
    });
    return { title: s.title, player, steps, held: match !== null };
  });
}

export default async function ReplayPage({ params, searchParams }: PageProps<"/replays/[id]">) {
  const [{ id }, { kinds, q, side }] = await Promise.all([params, searchParams]);
  const r = await getReplay(id);
  if (!r) notFound();
  const players = [...r.players].sort((a, b) => a.player_id - b.player_id);
  const objects = await getObjects([...new Set([...r.events.map((e) => e.code), ...players.flatMap((p) => p.heroes.map((h) => h.code))])]);
  const who = new Map(players.map((p) => [p.player_id, p]));
  const marks = typeof q === "string" && typeof side === "string" ? await searchMarks(q, side, players, r.events) : [];
  // per player, the step numbers of each matched order, keyed "event_type/code/time_ms"
  const hits: Record<number, Record<string, number[]>> = {};
  for (const m of marks)
    for (const s of m.steps) for (const h of s.hits) ((hits[m.player.player_id] ??= {})[`${h.event_type}/${h.code}/${h.time_ms}`] ??= []).push(h.n);

  return (
    <>
      <section className="banner">
        <div className="wrap py-7">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <h1 className="mr-auto min-w-0 text-primary [overflow-wrap:anywhere]">{r.map || "Unknown map"}</h1>
            {r.download_url ? (
              <a className="btn btn-gold" href={r.download_url}>
                Download replay
              </a>
            ) : (
              <span className="text-banner-muted">No file</span>
            )}
          </div>
          <p className="mt-3 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-lg [&_img]:rounded-full [&_img]:ring-1 [&_img]:ring-banner-muted">
            {players.map((p, i) => (
              <Fragment key={p.player_id}>
                {i > 0 && <span className="text-banner-muted">v</span>}
                <span className="inline-flex min-w-0 items-center gap-2">
                  <PlayerName name={p.name} race={p.race} />
                  {p.won && <Result won />}
                </span>
              </Fragment>
            ))}
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-banner-muted">
            <span className="inline-flex items-center gap-1.5">
              <Timer label="Length" />
              {mss(r.duration_ms)}
            </span>
            <span>{matchup(players)}</span>
            {r.patch && <span>Patch {r.patch}</span>}
          </p>
        </div>
      </section>

      <main className="wrap flex flex-col gap-4 py-6">
        <div className="grid gap-4 md:grid-cols-2">
          {players.map((p, i) => (
            <section key={p.player_id} className="card">
              <div className="bar">
                <SeriesKey i={i} />
                <h3 className="min-w-0">
                  <PlayerName name={p.name} race={p.race} />
                </h3>
                <span className="ml-auto">
                  <Result won={p.won} />
                </span>
              </div>
              <div className="p-4">
                <p className="flex items-baseline gap-2">
                  <span className="text-[2.5rem] leading-none font-bold">{p.apm}</span>
                  <span className="text-muted">APM</span>
                </p>
                <ul className="mt-4 flex flex-col gap-3.5 border-t pt-4">
                  {[...p.heroes]
                    .sort((a, b) => a.slot - b.slot)
                    .map((h) => (
                      <li key={h.slot} className="grid grid-cols-[40px_1fr] items-start gap-3">
                        <ObjIcon code={h.code} objects={objects} size={40} alt="" />
                        <div>
                          <p>
                            <span className="font-bold">{objects[h.code]?.name ?? "Unknown hero"}</span>
                            <span className="ml-2 text-muted">Level {h.final_level}</span>
                          </p>
                          <SkillTrail
                            className="mt-1.5"
                            objects={objects}
                            skills={r.events.filter((e) => e.player_id === p.player_id && e.event_type === "hero_skill" && e.hero_code === h.code)}
                          />
                        </div>
                      </li>
                    ))}
                </ul>
              </div>
            </section>
          ))}
        </div>

        <GameTimeline
          players={players.map(({ player_id, name, race, apm_per_minute }) => ({ player_id, name, race, apm_per_minute }))}
          events={r.events}
          objects={objects}
          durationMs={r.duration_ms}
          kinds={typeof kinds === "string" ? kinds : undefined}
          hits={hits}
          legend={
            marks.length > 0 && (
              <div className="step-legend">
                {marks.map((m) => (
                  <div key={m.title} className="min-w-0">
                    <p className="mb-1.5 flex flex-wrap items-center gap-x-2 text-sm">
                      <span className="text-muted">{m.title}</span>
                      <PlayerName name={m.player.name} race={m.player.race} />
                      {!m.held && <span className="text-muted">Not found in this game</span>}
                    </p>
                    <ol aria-label={`Steps of the ${m.title.toLowerCase()}`} className="flex flex-col gap-1 text-sm">
                      {m.steps.map((s) => (
                        <li key={s.n} className="flex items-baseline gap-2">
                          <span className="step-no static" aria-hidden>
                            {s.n}
                          </span>
                          <span className="min-w-0">
                            {s.words}
                            {s.negate && " did not happen"}
                          </span>
                          {s.time && <span className="ml-auto shrink-0 text-muted">{s.time}</span>}
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
                <Link href={`/?${q}`} className="col-span-full text-sm">
                  Back to the search
                </Link>
              </div>
            )
          }
        />

        {r.chat.length > 0 && (
          <section className="card">
            <div className="bar">
              <h2>Chat</h2>
            </div>
            <ul className="px-4 py-3">
              {r.chat.map((c, i) => {
                const p = who.get(c.player_id);
                return (
                  <li key={i} className="grid grid-cols-[44px_1fr] items-baseline gap-x-3 py-1 sm:grid-cols-[44px_auto_1fr]">
                    <span className="text-muted">{mss(c.time_ms)}</span>
                    {p ? <PlayerName name={p.name} race={p.race} /> : <span className="font-name">Observer</span>}
                    <span className="col-start-2 min-w-0 break-words sm:col-start-auto">{c.message}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}
