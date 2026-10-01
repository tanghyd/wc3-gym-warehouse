import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { getObjects, getReplay } from "@/lib/api";
import { matchup, mss, ObjIcon, PlayerName, Result, SeriesKey, SkillTrail, Timer } from "@/lib/ui";
import { GameTimeline } from "./GameTimeline";

export async function generateMetadata({ params }: PageProps<"/replays/[id]">): Promise<Metadata> {
  const r = await getReplay((await params).id);
  return { title: r ? r.map || "Unknown map" : "No game with this id" };
}

export default async function ReplayPage({ params, searchParams }: PageProps<"/replays/[id]">) {
  const [{ id }, { kinds }] = await Promise.all([params, searchParams]);
  const r = await getReplay(id);
  if (!r) notFound();
  const players = [...r.players].sort((a, b) => a.player_id - b.player_id);
  const objects = await getObjects([...new Set([...r.events.map((e) => e.code), ...players.flatMap((p) => p.heroes.map((h) => h.code))])]);
  const who = new Map(players.map((p) => [p.player_id, p]));
  const inferred = r.result_source === "last_actor";

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
                  {p.won && <Result won inferred={inferred} />}
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
            {r.gnl && (
              <span>
                GNL S{r.gnl.series_id} G{r.gnl.game_no}
              </span>
            )}
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
                  <Result won={p.won} inferred={inferred} />
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
