// The race values every race control and row speaks. A player of a game has a played race and a
// flag for a picked Random; the nine values name the pair: HU means picked Human, RH a Random player
// who rolled Human, and R a Random player with no played race (no race-specific order).

/** Race value -> name, race-icons/ file and matchup letter. */
export const RACES: Record<string, [string, string, string]> = {
  HU: ["Human", "HUMAN", "H"],
  OC: ["Orc", "ORC", "O"],
  NE: ["Night Elf", "NIGHT_ELF", "N"],
  UD: ["Undead", "UNDEAD", "U"],
  RH: ["Random Human", "RANDOM_HUMAN", "H"],
  RO: ["Random Orc", "RANDOM_ORC", "O"],
  RN: ["Random Night Elf", "RANDOM_NIGHT_ELF", "N"],
  RU: ["Random Undead", "RANDOM_UNDEAD", "U"],
  R: ["Random", "RANDOM", "R"],
};

/** The four races, in the order of every menu, column and legend. */
export const PICKED = ["HU", "OC", "NE", "UD"] as const;
/** Each race's Random value. */
export const RANDOM_OF: Record<string, string> = { HU: "RH", OC: "RO", NE: "RN", UD: "RU" };
/** The race menu counts' keys for every game and for every game with a Random player of a race. */
export const ANY_RACE = "";
export const ANY_RANDOM = "random";
const BASE_OF: Record<string, string> = Object.fromEntries(Object.entries(RANDOM_OF).map(([r, v]) => [v, r]));

/** The value of a played race and its random flag: ("NE", 1) -> "RN", ("RANDOM", 1) -> "R". */
export function raceValue(race: string, random: number | boolean) {
  if (!RANDOM_OF[race]) return "R";
  return random ? RANDOM_OF[race] : race;
}

/** The played race and random flag of a value: "RN" -> ["NE", 1]. */
export function racePair(value: string): [string, number] {
  if (BASE_OF[value]) return [BASE_OF[value], 1];
  return RACES[value] && value !== "R" ? [value, 0] : ["RANDOM", 1];
}

/** A race control's value from the URL, such as "NE,RN": known values only, in menu order. */
export function parseRaces(text: string | undefined) {
  const set = new Set((text ?? "").split(","));
  return Object.keys(RACES).filter((v) => set.has(v));
}

/**
 * The player_games filters for a race control's values, on `race` and `random` or their
 * opponent_ pair. A control holds one value, or a race with its Random value, so a filter on
 * each column says it exactly: ["NE", "RN"] is race NE with either flag.
 */
export function raceFilters(values: string[], race = "race", random = "random"): Record<string, (string | number)[]> {
  if (!values.length) return {};
  const pairs = values.map(racePair);
  const flags = [...new Set(pairs.map((p) => p[1]))];
  return { [race]: [...new Set(pairs.map((p) => p[0]))], ...(flags.length === 1 && { [random]: flags }) };
}

/** A race control's values in words: "Night Elf", "Night Elf or Random Night Elf", "Any race". */
export const raceLabel = (values: string[]) => (values.length ? values.map((v) => RACES[v][0]).join(" or ") : "Any race");
