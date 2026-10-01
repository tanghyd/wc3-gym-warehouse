// Marks and formats shared by the server pages and the client charts.
import type { GameEvent, Objects } from "./api";

/** GNL race id -> name and race-icons/ file. */
export const RACES: Record<string, [string, string]> = {
  HU: ["Human", "HUMAN"],
  OC: ["Orc", "ORC"],
  NE: ["Night Elf", "NIGHT_ELF"],
  UD: ["Undead", "UNDEAD"],
  RANDOM: ["Random", "RANDOM"],
};

/** Milliseconds as m:ss, 937219 -> 15:37. */
export const mss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export const shortName = (name: string) => name.split("#")[0];

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

/** A result as a word on its win, loss or draw fill. */
export function Result({ won }: { won: boolean | null }) {
  const [label, tone] = won === null ? ["No result", "bg-draw text-on-draw"] : won ? ["Won", "bg-win text-on-win"] : ["Lost", "bg-loss text-on-loss"];
  return <span className={`chip ${tone}`}>{label}</span>;
}

/** The 2 px line key of a player's series. */
export function SeriesKey({ i }: { i: number }) {
  return <span aria-hidden className={`inline-block h-0.5 w-4 shrink-0 rounded-full ${i === 0 ? "bg-series-1" : "bg-series-2"}`} />;
}

/** An object's command-card icon; alt="" where its name stands beside it. */
export function ObjIcon({ code, objects, size, alt }: { code: string; objects: Objects; size: number; alt: string }) {
  const icon = objects[code]?.icon;
  if (!icon)
    return (
      <span role={alt ? "img" : undefined} aria-label={alt || undefined} className="block shrink-0 rounded-sm border bg-surface-light" style={{ width: size, height: size }} />
    );
  return <img src={icon} width={size} height={size} alt={alt} className="block shrink-0 rounded-sm" />;
}

const nameOf = (objects: Objects, code: string) => objects[code]?.name ?? code;

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
