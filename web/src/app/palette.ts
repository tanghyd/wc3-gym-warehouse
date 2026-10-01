// The stone-and-gold palette of wc3-gym-frontend (next/src/helpers/palette.mjs), cut to the
// tokens these pages use, plus the two player colours of the replay page.
type Theme = { scheme: string; colors: Record<string, string>; variables: Record<string, string | number> };

// The player pair is jade and orchid: no win blue, loss red or gold, and no race hue, since a
// mirror match has two players of one race. dataviz validate_palette.js --pairs all, on surface:
// light 12.7 colour blind (deutan), 29.2 full vision; dark 11.3 and 31.0. Against win, loss and
// gold each one keeps 9.6 colour blind and 17.4 full vision or more in both themes.
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
    primary: "#E7B643",
    "on-primary": "#1A140C",
    "primary-text": "#916200",
    banner: "#2B2117",
    "on-banner": "#FBF7F1",
    win: "#1F63A6",
    loss: "#B31220",
    draw: "#A8A29A",
    // palette-style.ts gives light win and loss white ink
    "on-win": "#FBF7F1",
    "on-loss": "#FBF7F1",
    "on-draw": "#1A241E",
    "series-1": "#02927B", // lower player_id; 3.55:1 on surface
    "series-2": "#C061D6", // 3.24:1 on surface
  },
  variables: { "border-color": "#1A241E", "border-opacity": 0.2, "medium-emphasis-opacity": 0.78 },
};

const dark: Theme = {
  scheme: "dark",
  colors: {
    background: "#080503",
    surface: "#0C0805",
    "surface-light": "#1B1915",
    "surface-variant": "#D5DBD1",
    "on-surface-variant": "#1A241E",
    "on-background": "#E7EBE3",
    "on-surface": "#E7EBE3",
    primary: "#E7B643",
    "on-primary": "#1A140C",
    "primary-text": "#E7B643",
    banner: "#1E1710",
    "on-banner": "#FBF7F1",
    win: "#4996F5",
    loss: "#E24947",
    draw: "#5E5B56",
    "on-win": "#1A241E",
    "on-loss": "#1A140C",
    "on-draw": "#FBF7F1",
    "series-1": "#16A08A", // 6.11:1 on surface
    "series-2": "#B03CAE", // 3.90:1 on surface
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
