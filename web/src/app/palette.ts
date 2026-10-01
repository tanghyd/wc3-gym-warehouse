// The stone-and-bronze palette of wc3-gym-frontend (next/src/helpers/palette.mjs), cut to the
// tokens these pages use, plus the two player colours of the replay page.
type Theme = { scheme: string; colors: Record<string, string>; variables: Record<string, string | number> };

const light: Theme = {
  scheme: "light",
  colors: {
    background: "#E8E9E3",
    surface: "#F4F5F1",
    "surface-light": "#E1E4DD",
    "surface-variant": "#1C2420",
    "on-surface-variant": "#F2F4ED",
    "on-background": "#1A241E",
    "on-surface": "#1A241E",
    primary: "#9A5B18",
    "primary-darken-1": "#7C4912",
    "on-primary": "#FBF7F1",
    "primary-text": "#7C4912",
    band: "#1C2420",
    "on-band": "#F2F4ED",
    "band-muted": "#B9C4B6",
    win: "#1F63A6",
    // lower player_id; the same blue as win, so a result on this page is a word, never this colour
    "series-1": "#1F63A6",
    "series-2": "#B03A7A",
  },
  variables: { "border-color": "#1A241E", "border-opacity": 0.2, "medium-emphasis-opacity": 0.78 },
};

const dark: Theme = {
  scheme: "dark",
  colors: {
    background: "#191A16",
    surface: "#232420",
    "surface-light": "#2D2E2A",
    "surface-variant": "#D5DBD1",
    "on-surface-variant": "#1A241E",
    "on-background": "#E7EBE3",
    "on-surface": "#E7EBE3",
    primary: "#D08B3C",
    "primary-darken-1": "#B57430",
    "on-primary": "#1A140C",
    "primary-text": "#E3A45F",
    band: "#11110E",
    "on-band": "#F2F4ED",
    "band-muted": "#B9C4B6",
    win: "#4F95D8",
    "series-1": "#4F95D8",
    "series-2": "#C95E98",
  },
  variables: { "border-color": "#E7EBE3", "border-opacity": 0.12, "medium-emphasis-opacity": 0.7 },
};

// --v-theme-<token> as "r,g,b", the format the template's CSS reads.
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
};

const body = (t: Theme) =>
  [
    `color-scheme:${t.scheme}`,
    ...Object.entries(t.colors).map(([token, hex]) => `--v-theme-${token}:${rgb(hex)}`),
    ...Object.entries(t.variables).map(
      ([name, v]) => `--v-${name}:${typeof v === "string" && v.startsWith("#") ? rgb(v) : v}`,
    ),
  ].join(";");

/** The palette as one stylesheet: light under :root, dark when chosen or when the system asks. */
export function paletteStyle() {
  return [
    `:root{${body(light)}}`,
    `:root[data-theme="dark"]{${body(dark)}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]):not([data-theme="dark"]){${body(dark)}}}`,
  ].join("");
}

/** Runs before first paint, so a hard load never flashes the other ground. Key: `theme`. */
export const THEME_SCRIPT = `try{var m=localStorage.getItem('theme')||'system';if(m!=='system')document.documentElement.dataset.theme=m;}catch(e){}`;
