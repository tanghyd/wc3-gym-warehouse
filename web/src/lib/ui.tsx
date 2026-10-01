// Marks, fields and formats shared by the server pages and the client components.
import type { ComponentProps, ReactNode } from "react";
import type { GameEvent, Objects } from "./api";

/** GNL race id -> name, race-icons/ file and matchup letter. */
export const RACES: Record<string, [string, string, string]> = {
  HU: ["Human", "HUMAN", "H"],
  OC: ["Orc", "ORC", "O"],
  NE: ["Night Elf", "NIGHT_ELF", "N"],
  UD: ["Undead", "UNDEAD", "U"],
  RANDOM: ["Random", "RANDOM", "R"],
};

/** The matchup in the order the players are shown: a race letter each, teams joined by "v". */
export function matchup(players: { race: string; team_id: number }[]) {
  const teams = new Map<number, string>();
  for (const p of players) teams.set(p.team_id, (teams.get(p.team_id) ?? "") + (RACES[p.race]?.[2] ?? "?"));
  return [...teams.values()].join("v");
}

/** Milliseconds as m:ss, 937219 -> 15:37. */
export const mss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export const shortName = (name: string) => name.split("#")[0];

/** A record as "wins – losses", with its percent from ten decided games up; an em dash with none. */
export function record(wins: number, losses: number) {
  const n = wins + losses;
  if (!n) return "—";
  return `${wins} – ${losses}` + (n >= 10 ? ` (${Math.round((100 * wins) / n)}%)` : "");
}

/** A filter field: its label above the control. */
export function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`flex min-w-36 flex-1 flex-col gap-1 text-sm ${className}`}>
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

/** The five races; "Any" first unless the race is required. */
export function RaceSelect({ any = true, ...props }: ComponentProps<"select"> & { any?: boolean }) {
  return (
    <select className="field" {...props}>
      {any && <option value="">Any</option>}
      {Object.entries(RACES).map(([id, [label]]) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
    </select>
  );
}

/** The line colour of the i-th player: series-1 for the lower player_id. */
export const seriesColor = (i: number) => `rgb(var(--v-theme-series-${i + 1}))`;

export function RaceIcon({ race, size = "1.4em" }: { race: string; size?: string }) {
  const r = RACES[race];
  if (!r) return null;
  return <img src={`/race-icons/${r[1]}.png`} alt={r[0]} title={r[0]} className="shrink-0" style={{ width: size, height: size }} />;
}

/** A player as name, in Cardo 700, then race icon. */
export function PlayerName({ name, race, className = "" }: { name: string; race: string; className?: string }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <span className="font-name truncate">{name}</span>
      <RaceIcon race={race} />
    </span>
  );
}

/**
 * A result as a word on its win, loss or draw fill. An inferred one (result_source last_actor) adds the
 * word "inferred" in the ink around it, so it reads on a table and on a banner alike.
 */
export function Result({ won, inferred = false }: { won: boolean | null; inferred?: boolean }) {
  const [label, tone] = won === null ? ["No result", "bg-draw text-on-draw"] : won ? ["Won", "bg-win text-on-win"] : ["Lost", "bg-loss text-on-loss"];
  const chip = <span className={`chip ${tone}`}>{label}</span>;
  if (!inferred || won === null) return chip;
  const who = won ? "the other player" : "this player";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={`Inferred: ${who} stopped first; the file has no leave record`}>
      {chip} <span className="text-sm italic">inferred</span>
    </span>
  );
}

/** The 2 px line key of a player's series. */
export function SeriesKey({ i }: { i: number }) {
  return <span aria-hidden className={`inline-block h-0.5 w-4 shrink-0 rounded-full ${i === 0 ? "bg-series-1" : "bg-series-2"}`} />;
}

/** An object's command-card icon, or a "?" tile when it has none; alt="" where its name stands beside it. */
export function ObjIcon({ code, objects, size, alt, title }: { code: string; objects: Objects; size: number; alt: string; title?: string }) {
  const icon = objects[code]?.icon;
  if (!icon)
    return (
      <span
        role={alt ? "img" : undefined}
        aria-label={alt || undefined}
        title={title}
        // the "?" is CSS content, so it stays out of the row's text
        className="grid shrink-0 place-items-center rounded-sm border bg-surface-light leading-none font-bold text-muted before:content-['?']"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}
      />
    );
  return <img src={icon} width={size} height={size} alt={alt} title={title} className="block shrink-0 rounded-sm" />;
}

/** A checkbox in a filter row: its label beside it, as tall as a field. */
export function Check({ label, ...props }: Omit<ComponentProps<"input">, "type"> & { label: string }) {
  return (
    <label className="flex h-[38px] cursor-pointer items-center gap-2 text-sm whitespace-nowrap">
      <input type="checkbox" className="size-4 shrink-0 cursor-pointer accent-primary-text" {...props} />
      {label}
    </label>
  );
}

const nameOf = (objects: Objects, code: string) => objects[code]?.name ?? "Unknown skill";

/** A hero's skills in time order: 24 px icon, m:ss under it. */
export function SkillTrail({ skills, objects, className = "" }: { skills: GameEvent[]; objects: Objects; className?: string }) {
  if (!skills.length) return null;
  return (
    <ol className={`flex flex-wrap gap-2.5 ${className}`}>
      {skills.map((s, j) => (
        <li key={j} className="flex flex-col items-center gap-0.5 text-xs text-muted" title={`${nameOf(objects, s.code)} at ${mss(s.time_ms)}`}>
          <ObjIcon code={s.code} objects={objects} size={24} alt={nameOf(objects, s.code)} />
          <span>{mss(s.time_ms)}</span>
        </li>
      ))}
    </ol>
  );
}

export function Timer({ label }: { label: string }) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" className="shrink-0" role="img" aria-label={label}>
      <title>{label}</title>
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="13.5" r="7.5" />
        <path d="M12 9.5v4l2.5 2M9.5 3h5" />
      </g>
    </svg>
  );
}
