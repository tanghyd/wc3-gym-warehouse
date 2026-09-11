# Warehouse frontend design

- Written 2026-09-11. Condensed 2026-09-11 with the final decisions.
- Scope: the Vite + Vue 3 + Vuetify 3 app that replaces `frontend/index.html`, for the four stories in `docs/design/stories.md`. The HTTP contract is `docs/design/api.md`. This file does not change it.
- Paths are relative to this repo. `gnl:` means `wc3-gym-frontend` at `origin/main`. `vuetify:` means `node_modules/vuetify/lib/` in the gnl clone (Vuetify 3.8.0).
- Data: examples in sections 4 and 12 come from the 3 fixture replays. Examples in sections 10 and 11 and the mockups come from the local dev set: 6,567 replays (`SELECT count() FROM w3g.replays FINAL`, 2026-09-11; 6,564 from `gs://w3warehouse-05b6-replays/w3g/gnl/` plus the 3 fixtures), measured on 26.9. The dev set is for debugging only. The org deploy holds only app-reported GNL replays.
- Palette checks: the `dataviz` skill validator (`scripts/validate_palette.js`), run 2026-09-11 (section 6.5).
- This file also owns how the app ships: Vite dev, build, nginx, compose and CI (section 14).

## 1. Summary

| Part | Decision |
|---|---|
| Stack | Vue 3, Vuetify 3, vue-router 4, `d3-scale`, `d3-axis`, `d3-selection`, `d3-shape`. Same versions as gnl `package.json:13-26`. No Pinia. |
| Routes | `/search`, `/openers`, `/stats`, `/replays/:id`. History mode. `/` redirects to `/search`. |
| Shell | The gnl shell: `v-app-bar` with title and inline nav links, a `v-navigation-drawer` below md (gnl: `src/App.vue:147-148, 214`). |
| State | The route query holds every filter, step, sort, page and selection. A pasted link gives the same result. |
| Server data | Fetched per page from `/api/...`. The HTTP cache (api.md 2.7) serves repeats. No client store. |
| Look | The GNL stone-and-bronze style, light only (section 6). Every colour is a named token. No colour or font outside the tokens, except one `ground` in `index.html` (6.2). |
| The one bold element | Build orders render as rows of Warcraft III command-card icons: the picker, the step list, the opener trail and the timeline. Everything else stays quiet (6.4). |
| Orders | Replays record commands, not outcomes. Every screen that shows orders or counts says "ordered". Flagged repeats (`is_repeat = 1`, PR 2) never show and never count. |
| Names | `{name} {race}` until the dims loader lands (after the four pages). No flag, no MMR, no season or team filter. |
| Random | `R` is the queued race and a fifth race in every race control. Its events carry the rolled race's codes (9.3). |

## 2. App layout under `frontend/`

PR 10 moves `frontend/index.html` (1046 lines, CDN Vue) to `frontend/public/legacy/index.html`, served at `/legacy/`. PR 14 deletes it (plan.md P2). The Vite app takes its place:

```
frontend/
  index.html               Vite entry. Google Fonts links and the `ground` style (6.2, 6.3).
  package.json             deps as section 1. "test": node --test "src/**/*.test.mjs" (gnl: package.json:8).
  package-lock.json        committed; npm ci needs it (section 14)
  vite.config.js           @ alias, /api proxy with rewrite (14.2)
  public/icons/            the 530 command-card PNGs, moved from frontend/icons/ unchanged
  public/legacy/           the old page, PR 10 to PR 14
  src/
    main.js                createVuetify with the theme block (6.2), router, global components
    App.vue                app bar, nav links, drawer below md, <router-view>
    router.js              flat routes (section 3)
    api.js                 fetch client (section 5)
    query.js               URL codec (section 4)
    query.test.mjs         the one test file (4.4)
    format.js              fmtPct, m:ss format and parse, WIN_RATE_FLOOR (section 13)
    tokens.js              the colour tokens (6.1)
    races.js               gnl: src/helpers/races.js, keyed by H O N U R
    objects.js             /mappings cache, icons.json lookup, code -> event_type
    icons.json             moved from frontend/icons.json, imported as a module
    assets/base.css        gnl: src/assets/base.css, verbatim
    assets/style.css       fonts, type classes, field and ghost-button borders (6.2, 6.3)
    assets/raceIcons/*.png moved from frontend/race-icons/ (same 5 files as gnl)
    components/
      PlayerName.vue  RaceIcon.vue  RaceSelect.vue  GroupedTable.vue   (copied, section 7)
      FilterRow.vue  ObjectIcon.vue  ObjectPicker.vue  StepList.vue (one slot's steps)  ReplayTable.vue  StateBlock.vue
      charts/useWidth.js   ResizeObserver width ref (gnl: DivisionBracketing.vue:121-122, 130)
      charts/ChartTooltip.vue  ColumnChart.vue  BarList.vue  DivergingBars.vue  ApmLine.vue  BuildTimeline.vue
    views/
      SearchView.vue  OpenersView.vue  StatsView.vue  ReplayView.vue  NotFoundView.vue
infrastructure/docker/
  Dockerfile.ui            node build, then nginx (14.1)
  nginx-ui.conf            dist, history fallback, /api/ proxy (14.1)
```

- `public/icons/` keeps the file names, so `icons.json` values stay valid (`index.html:666` builds `'icons/' + file`).
- Decided: import `icons.json` as a module (F8). Why: no runtime fetch (`index.html:1019`), no frame of empty icons.

## 3. Routing and shell

`createRouter({ history: createWebHistory(), routes })`, as gnl `src/helpers/router.js:1, 13`. No `meta.role`, no `beforeEach`. Reads are open.

| Path | View | Query keys it reads |
|---|---|---|
| `/` | redirect to `/search` | |
| `/search` | SearchView | shared (4.1), search (4.2), paging (4.3) |
| `/openers` | OpenersView | shared, `sort`, `open`, `sel`, `page` |
| `/stats` | StatsView | shared |
| `/replays/:id` | ReplayView | `kinds` |
| `/:rest(.*)*` | NotFoundView | |

| Width | Shell (gnl `src/App.vue`) |
|---|---|
| md and up | `v-app-bar` (line 147). `v-app-bar-title` "GNL replays", a link to `/search`. Links Search, Openers, Stats in the append slot (lines 153-174, the `!smAndDown` branch). |
| below md | The same bar with a `v-app-bar-nav-icon` (line 148). It opens a `temporary` `v-navigation-drawer` with the three links (line 214). |

- The title shows at every width.
- Nav links keep the shared keys, so a filter set follows the reader.
- Back from a replay page returns to the list with its query intact.

## 4. State: the URL is the state

Decided (stories D2): a view never holds a filter or selection that is not also in the query. Chart-or-table toggles are the one exception: local view state.

| Event | Router call |
|---|---|
| Filter row change on `/openers`, `/stats` | `router.replace` (gnl `SeasonSelect.vue:32`) |
| "Search" button on `/search` | `router.push`. Back returns to the previous search. |
| Page, sort | `router.replace` |
| Open, close or select an opener row | `router.replace` |

- Each view has one `watch(() => route.query, load, { immediate: true })`. `load` decodes the query, calls the API and aborts the previous request (`AbortController`). A slow old answer never overwrites a new one.
- Text fields (player, minutes) write to the query after 400 ms without typing, or on Enter.
- On `/search` the builder edits a draft copy. The query changes only on "Search". The draft resets from the query on every route change.

### 4.1 Shared keys

The same names as the API filters (api.md 2.2).

| Control | Query key | `/openers`, `/stats` param | `/search` body field (api.md 2.3) |
|---|---|---|---|
| Race | `race` | `race` | `groups[0].race` |
| Opponent race | `opponent_race` | `opponent_race` | `groups[1].race` |
| Map | `map` | `map` | `map` |
| Player | `player` | `player` | `groups[0].player` |
| Min minutes | `min_minutes` | `min_minutes` | `min_minutes` |
| Max minutes | `max_minutes` | `max_minutes` | `max_minutes` |

### 4.2 Search keys

| Control | Query key | Body field |
|---|---|---|
| Player 1 outcome | `result` | `groups[0].result` |
| Player 1 steps | `steps` | `groups[0].steps` |
| Player 1 without (PR 16) | `without` | the PR 15 group field (api.md 3.4) |
| Player 2 name | `opp_player` | `groups[1].player` |
| Player 2 outcome | `opp_result` | `groups[1].result` |
| Player 2 steps | `opp_steps` | `groups[1].steps` |
| Player 2 without (PR 16) | `opp_without` | the PR 15 group field |

Step codec. One step is one token. Tokens join with `,`.

```
[^]<code>[*<min_count>][~<within_previous_seconds>][@<time_from_seconds>-<time_to_seconds>]
steps=eate,eaom~30,Edem@-300      eate, then eaom within 30 s, then Demon Hunter by 5:00
steps=earc*5@-300                 at least 5 Archer orders by 5:00 (PR 16)
steps=^Edem                       first hero Demon Hunter (PR 16)
without=eden                      no Ancient of Wonders ordered, up to 3 codes (PR 16)
```

- The code alone gives `event_type`. A code is unique among the 649 `/mappings` rows (api.md 3.2). The kind maps to `event_type` by the table in api.md 3.2.
- An empty side of `@` means no bound. A blank timing is "no constraint", never zero (`index.html:491`).
- Groups: when only slot 2 has content, the body sends `[{}, {...}]`. The index is the player (api.md A11). When no slot has content, `groups` is `[]`, which lists every game (api.md 3.4 "No groups").
- A bad value in a pasted link passes through. The API answers 400 and names the field (api.md 2.6). The UI shows that text (5.2). The codec does not re-implement validation.

### 4.3 Paging and openers keys

| Key | Default | Meaning |
|---|---|---|
| `page` | 1 | `offset = (page - 1) * 25`, `limit=25` (api.md 2.4). On `/openers` it pages the panel's replay list and resets to 1 when `sel` changes. |
| `sort` | `popular` | `/openers` only: `popular` or `winrate` (api.md 3.5). Search lists have one fixed order and no sort key (api.md 2.4, A2). |
| `open` | none | Opened prefixes, one key per row: `open=eate&open=eate.eaom`. Codes join with `.`. |
| `sel` | none | The one selected prefix: `sel=eate.eaom.etoa`. On decode every parent of `sel` joins `open`. |

### 4.4 Test

`src/query.test.mjs`, plain `node --test` as gnl `package.json:8`:

- Round trip: query to state to query, for every key above.
- The step token grammar, including `~` on step 0 (passed through, the API rejects it), `@-300`, `*5` and `^` (PR 16).
- `[{}, {...}]` when only slot 2 is set, `[]` when nothing is set.
- Code to `event_type` for `eate`, `ankh`, `Recb`, `Edem`, `AEmb` (api.md 3.2).
- `m:ss` parsing: `5` gives 300 s, `5:30` gives 330 s, blank gives none.
- `sel=a.b.c` with no `open` decodes to `open` = `a`, `a.b`.
- `WIN_RATE_FLOOR` equals 10 (section 13).

## 5. API client and errors

### 5.1 Client

`src/api.js` copies the request core of gnl `src/helpers/fetch-wrapper.js`:

| Copied | gnl lines | Change |
|---|---|---|
| `responseError(body, text, status)` | 121 | none; it reads `body.error` |
| JSON-or-text body parse | 140, 156 | none |
| `X-Total-Count` read into `{ items, total }` | 162 | none |
| `pageQuery` drops empty keys | 20-31 | none. The API treats `race=` as no `race` (api.md 2.1). |
| 401 logout branch and auth headers | 131 | dropped. No auth. |

- Base path `/api`. Every call takes an `AbortSignal`. Calls: `get(path, params)`, `getPage(path, params)`, `postPage(path, params, body)`.
- `/mappings` and `/filters` load once, in `objects.js` and `FilterRow.vue`, into module-level refs. The browser cache covers reloads (1 hour and 60 s, api.md 2.7).
- The client sends only the keys its route uses. The API returns 400 on an unknown key (api.md 2.1): `steps` never reaches `/stats`; `sel` and `open` never reach any route.

### 5.2 Error display

`StateBlock.vue` renders every non-data state in the content area. The filter row stays live above it.

| Case | Detect | Shows |
|---|---|---|
| Offline | `fetch` network error, or 503 `warehouse offline` | "Warehouse offline" and "Retry". Retry calls the page's `load`, not `GET /health` (api.md 3.1). |
| Busy | 503 `warehouse busy: retry` | The API text and "Retry" |
| Bad input | 400 | The API text in `v-alert type="error"`: validation, `search too complex`, `query reads too much` (api.md 2.6). On `/search`, text that starts with `groups[i].steps[j]` also sets that step's `error-messages`. |
| Query too heavy | 503 memory (code 241), 504 | The API text, e.g. "query took too long: narrow the filters". No Retry. |
| Replay not found | 404 on `/replays/:id` | "No game with this id" and a link to Search |
| Other | 500 | "warehouse query failed" and "Retry" |

- The API never sends SQL or ClickHouse text (api.md 2.6), so the UI shows `error` as is.
- Vue interpolation escapes text. No view uses `v-html`. Player names and chat are untrusted.

## 6. Visual system

- Light only. The incoming GNL app style (Daniel, 2026-09-11) replaces stock Vuetify blue and Roboto.
- Reference: `scratch/gnl-front-door/` in the gym root. `_head.txt` holds the component CSS. `gnl-front-door.html` is the built page, rendered and checked 2026-09-11.
- The mockups link `design/mockups/tokens.css`: the tokens as CSS custom properties, the font import, base type and shared classes. Where it and this section differ, this section wins.
- No dark theme and no theme control ship (section 16, question 2).

### 6.1 Tokens

`src/tokens.js` holds every colour as a named token. The Vuetify theme reads it (6.2). `tokens.css` copies it with the same names (`--line` in a mockup is `rgb(var(--v-theme-line))` in the app). No component holds a colour.

| Token | Value | Use | Vuetify colour |
|---|---|---|---|
| `ground` | `#E8E9E3` | page ground | `background` |
| `surface` | `#F4F5F1` | app bar, panels, fields, chart surface | `surface` |
| `fill` | `#E1E4DD` | read-only fields, row hover, disabled buttons | |
| `tag` | `#DCE1D8` | tag fill | |
| `ink` | `#1A241E` | text, headings, numbers | `on-background`, `on-surface` |
| `ink-2` | `#3F4C43` | secondary text, tag and chip text | `secondary`, `on-tag` |
| `muted` | `#5F6B61` | labels, meta, column heads, axis text, numbers under the win-rate floor | |
| `faint` | `#6E7A70` | disabled and read-only text, placeholders. Never data text. | |
| `line` | `#CBD1C7` | 1 px dividers, panel borders, grid and axis lines, chart tracks | the `border-color` variable |
| `field-line` | `#B9C1B6` | field and chip borders | |
| `field-line-strong` | `#A7B1A4` | field hover, ghost-button border | |
| `bronze` | `#9A5B18` | the accent: primary button, active nav underline, selected row bar, selected chip border, focus ring | `primary` |
| `bronze-ink` | `#7C4912` | bronze text: links, quiet buttons, selected chip text | |
| `on-bronze` | `#FBF7F1` | text on `bronze` | `on-primary` |
| `band` | `#1C2420` | the dark band: tooltips | `surface-variant` |
| `on-band` | `#F2F4ED` | text on `band` | `on-surface-variant` |
| `on-band-muted` | `#B9C4B6` | muted text on `band` | |
| `danger` | `#8C3B2A` | error text, error alert, busy and offline state | `error` |
| `series-1` | `#2A6496` | player 1 mark (lower `player_id`) | |
| `series-2` | `#C0721C` | player 2 mark | |
| `win` | `#2A6496` | win mark, above 50 % | |
| `loss` | `#B5452F` | loss mark, below 50 % | |
| `magnitude` | `#7D877E` | one-series bars and columns | |

- Two tints derive from tokens and are not tokens: `bronze` at 12 % (selected row, selected chip, accent tag) and `danger` at 14 % (danger tag). App: `rgba(var(--v-theme-bronze), 0.12)`. Mockups: `color-mix(in srgb, var(--bronze) 12%, transparent)`.
- The chart tokens are proposals. The GNL theme PR picks the final pairs (section 16, question 3).
- Text contrast (WCAG, computed 2026-09-11):

| Text | On `surface` | On `ground` | On `fill` |
|---|---|---|---|
| `ink` | 14.58:1 | 13.08:1 | 12.43:1 |
| `ink-2` | 8.24:1 | 7.39:1 | 7.03:1 |
| `muted` | 5.10:1 | 4.57:1 | 4.34:1 (below 4.5:1) |
| `faint` | 4.10:1 (below 4.5:1) | 3.67:1 | 3.49:1 |
| `bronze-ink` | 6.80:1 | 6.10:1 | 5.80:1 |
| `danger` | 6.91:1 | 6.20:1 | 5.89:1 |

- `on-bronze` on `bronze` 5.07:1. `on-band` on `band` 14.32:1. `on-band-muted` on `band` 8.80:1. `ink-2` on `tag` 6.79:1.
- So: no `muted` text on `fill`, no data text in `faint` or `text-disabled`, and `ink-2` is the tag text.

### 6.2 Vuetify theme

```js
// src/tokens.js: the one colour source. Light only.
export const tokens = {
  ground: '#E8E9E3', surface: '#F4F5F1', fill: '#E1E4DD', tag: '#DCE1D8',
  ink: '#1A241E', 'ink-2': '#3F4C43', muted: '#5F6B61', faint: '#6E7A70',
  line: '#CBD1C7', 'field-line': '#B9C1B6', 'field-line-strong': '#A7B1A4',
  bronze: '#9A5B18', 'bronze-ink': '#7C4912', 'on-bronze': '#FBF7F1',
  band: '#1C2420', 'on-band': '#F2F4ED', 'on-band-muted': '#B9C4B6',
  danger: '#8C3B2A',
  'series-1': '#2A6496', 'series-2': '#C0721C', win: '#2A6496', loss: '#B5452F', magnitude: '#7D877E',
}
```

```js
// src/main.js
import { tokens as t } from './tokens.js'

createVuetify({
  theme: {
    defaultTheme: 'light',
    themes: {
      light: {
        dark: false,
        colors: {
          ...t,
          background: t.ground, 'on-background': t.ink, 'on-surface': t.ink,
          primary: t.bronze, 'on-primary': t['on-bronze'],
          secondary: t['ink-2'], error: t.danger,
          'surface-variant': t.band, 'on-surface-variant': t['on-band'],
          'on-tag': t['ink-2'],
        },
        variables: { 'border-color': t.line, 'border-opacity': 1 },
      },
    },
  },
  defaults: {
    VTooltip: { openOnClick: true },
    VAppBar: { flat: true, border: 'b', color: 'surface' },
    VCard: { variant: 'flat', border: true, rounded: 'sm' },
    VBtn: { variant: 'flat', rounded: 'sm' },
    VChip: { rounded: 'sm' },
    VTextField: { variant: 'outlined', density: 'compact', rounded: 'sm', color: 'primary' },
    VAutocomplete: { variant: 'outlined', density: 'compact', rounded: 'sm', color: 'primary' },
    VSelect: { variant: 'outlined', density: 'compact', rounded: 'sm', color: 'primary' },
  },
})
```

- `...t` makes every token a theme colour. Vuetify emits `--v-theme-<name>` as an `r,g,b` triplet and the `.text-<name>`, `.bg-<name>`, `.border-<name>` classes (vuetify: `composables/theme.js:176-180, 279-282`). A key that starts with `on-` gets only a `.<name>` class.
- `variables['border-color']` is parsed from hex (theme.js:287-290). With `border-opacity` 1, every Vuetify border draws in `line`.
- `rounded: 'sm'` is 2 px, the reference radius.
- `success`, `info` and `warning` keep Vuetify's values. No view uses them.
- Components use tokens only: props (`color="primary"`, `color="win"`), classes (`text-muted`, `text-ink-2`, `bg-fill`; `text-muted` replaces `text-medium-emphasis`, because the opacity class blends differently on each ground), and CSS/SVG (`rgb(var(--v-theme-line))`, `fill: rgb(var(--v-theme-magnitude))`, `rgba(var(--v-theme-bronze), 0.12)`).
- `assets/base.css` from gnl stays verbatim: no upper-case buttons, sort-icon states, table scroll shadows. `assets/style.css` holds the font rules and type classes (6.3) and two border rules:

```css
.v-field--variant-outlined .v-field__outline { color: rgb(var(--v-theme-field-line)); --v-field-border-opacity: 1; }
.v-btn--variant-outlined { border-color: rgb(var(--v-theme-field-line-strong)); }  /* ghost buttons; Vuetify uses currentColor */
```

- Removed: gnl's `theme.js`, the three-way theme menu and the pre-paint script (gnl: `index.html:15-24`). They exist only to choose light or dark.
- The one colour outside `tokens.js`: `index.html` has `<style>html { background: #E8E9E3; }</style>` in its `<head>`. Vuetify injects the theme only when the JS runs, so a hard load would first paint white. It copies `ground`; a change to `ground` changes both.

### 6.3 Type

- Fonts load from Google Fonts. `index.html` has `<link rel="preconnect">` to `fonts.googleapis.com` and `fonts.gstatic.com` (crossorigin), then one stylesheet link:

```
https://fonts.googleapis.com/css2?family=Alegreya:wght@500;700;800&family=Alegreya+Sans:wght@400;500;700&family=Noto+Sans+KR:wght@400;500;700&family=Noto+Sans+SC:wght@400;500;700&display=swap
```

| Property | Stack | Weights | Use |
|---|---|---|---|
| `--font-display` | `"Alegreya", "Noto Sans KR", "Noto Sans SC", Georgia, serif` | 500, 700, 800 | app bar title, page title, panel titles, the hero figure |
| `--font-body` | `"Alegreya Sans", "Noto Sans KR", "Noto Sans SC", system-ui, sans-serif` | 400, 500, 700 | everything else |

- Names in the data (2,401 distinct `w3g.replay_players.name`, measured 2026-09-11): 34 contain Hangul, 34 Han, 23 Cyrillic, 18 non-ASCII Latin, 0 kana, 0 other scripts.
- Alegreya and Alegreya Sans carry Latin-ext and Cyrillic. Hangul falls to Noto Sans KR. Han falls to Noto Sans KR, else to Noto Sans SC (the render loaded SC, so KR lacks some of the Han). Google Fonts serves the Noto faces in `unicode-range` slices, so a page downloads only the slices its names use.
- Render check, 2026-09-11: a `tokens.css` sample page with `풋사과의반쪽#3225`, `微醺騎士#323123`, `КаланчаВорон#2539`, `Maňásek#2552` showed no boxed glyphs.
- Numerals: Alegreya defaults to old-style figures. `style.css` sets `lining-nums tabular-nums` on `html, body`.
- Vuetify sets Roboto in 80 rules of `vuetify/dist/vuetify.css` (3.8.0): `html`, the 14 classes `.text-h1` to `.text-overline`, their breakpoint forms and `.v-badge__badge`. None uses `!important`. `style.css` loads after Vuetify and overrides them:

```css
:root {
  --font-display: "Alegreya", "Noto Sans KR", "Noto Sans SC", Georgia, serif;
  --font-body: "Alegreya Sans", "Noto Sans KR", "Noto Sans SC", system-ui, sans-serif;
}
html, body { font-family: var(--font-body); font-variant-numeric: lining-nums tabular-nums; }
.text-subtitle-1, .text-subtitle-2, .text-body-1, .text-body-2, .text-button, .text-caption, .text-overline, .v-badge__badge { font-family: var(--font-body); }
.h1, .h2, .h3, .figure, .v-app-bar-title { font-family: var(--font-display); }
```

- `body` is in the rule because Bootstrap 4.5.2 CSS (loaded by gnl, `index.html:10-11`) sets a `body` font. The rule then holds when pages move into gnl. Whether Bootstrap stays is the GNL theme PR's choice.
- The breakpoint forms (`.text-md-h5`) keep Roboto. No view uses them (F14).
- Type scale, the same classes in `style.css` and `tokens.css`. Views do not use Vuetify's `text-h*` classes.

| Class | Face | Size, weight | Use |
|---|---|---|---|
| `.h1` | display | 30 px, 800 | page title (the replay map name) |
| `.h2` | display | 21 px, 700 | panel titles |
| `.h3` | display | 17 px, 700 | block titles in a panel (hero-pick races, timeline players) |
| `.figure` | display | 40 px, 700 | the hero figure (`/stats` games) |
| body | body | 15 px, 400 | rows, fields, text |
| `text-caption` | body | 12 px (Vuetify) | axis ticks, meta |
| `.brand` | display | 21 px, 800 | the app bar title |

### 6.4 Shapes and icons

| Part | Shape (reference `_head.txt`) |
|---|---|
| Radius | 2 px on buttons, fields, panels, tags, chips, tooltips and race icons |
| Lines | 1 px `line`. Fields and chips: 1 px `field-line`, `field-line-strong` on hover. |
| App bar | `surface`, 64 px, 1 px bottom `line`. Active nav link `ink` with a 2 px `bronze` underline; the others `muted`. |
| Panel | `surface` on `ground`, 1 px `line` border, no shadow. Head and body split by 1 px `line`. |
| Table | 1 px `line` row dividers, no zebra. Column heads 13 px `muted`. Hover `fill`. Selected row: bronze tint and a 3 px `bronze` bar at the left. |
| Button | Primary: `bronze`, `on-bronze` text. Ghost: no fill, `field-line-strong` border, `ink` text. Quiet: `bronze-ink` text. Disabled: `fill`, `faint` text. |
| Tag | Read-only label: `tag` fill, `ink-2` text. Accent: bronze tint, `bronze-ink`. Danger: danger tint, `danger`. |
| Chip | A toggle: `surface`, `field-line` border, `ink-2` text. On: bronze tint, `bronze` border, `bronze-ink` text. |
| Focus | 2 px `bronze` outline, 2 px offset |
| Tooltip | `band`, `on-band` text, 13 px |

- Command-card icons are 64 x 64 PNGs (`file frontend/icons/btn3m1-result.png`). Sizes: 40 px in the picker and opener path tiles, 28 px in step lists and opener trails, 24 px in the timeline and skill trails, 20 px on phones. `rounded="sm"`, no border.
- Decided: `ObjectIcon.vue` falls back to `mdi-help-box-outline` at the same size, name in the tooltip. Why: 3 of 649 named codes have no icon (`orbr` Reinforced Orc Burrow, `uzg1` Spirit Tower, `nits` Ice Troll Berserker).
- Race marks: `RaceIcon.vue` from gnl, 1.4 em square with a tooltip (gnl: `RaceIcon.vue:2-14, 21`).
- Player names: the GNL app standard is `{flag} {name} {race} {mmr}`. The warehouse has no country and no MMR until the dims loader, so `PlayerName` shows `{name} {race}`, keeps the empty flag slot and has no MMR slot (section 7).

### 6.5 Chart palette validation

Charts sit on panels, so the surface is `surface` `#F4F5F1`. Command, from the `dataviz` skill's `scripts/` folder, run 2026-09-11 (Node 21 needs the flag, because the file is an ES module named `.js`):

```
node --experimental-default-type=module validate_palette.js "<hexes>" --mode light --surface "#F4F5F1" [--pairs all]
```

Chosen (proposals until the GNL theme PR):

| Run | Colours | Result |
|---|---|---|
| Players (`series-1`, `series-2`) | `#2A6496`, `#C0721C` | PASS all. CVD ΔE 21.1 (protan), tritan 26.6. Normal ΔE 27.1. Contrast ≥ 3:1. |
| Win and loss (`win`, `loss`) | `#2A6496`, `#B5452F` | PASS all. CVD ΔE 15.7 (protan), tritan 28.0. Normal ΔE 24.5. Contrast ≥ 3:1. |
| Share bar, win, loss (`--pairs all`) | `#7D877E`, `#2A6496`, `#B5452F` | Chroma FAIL on the grey-green (0.018): expected, a neutral is not a hue. CVD worst `#B5452F`↔`#7D877E` 10.4 (deutan), tritan 13.7. Normal worst `#2A6496`↔`#7D877E` 16.2. Contrast ≥ 3:1. |

Other runs (inputs to the win/loss question, section 16):

| Run | Colours | Result | Note |
|---|---|---|---|
| Vuetify blue, Material red | `#1867C0`, `#F44336` | PASS all. CVD 22.1 (protan), normal 36.5. | Stock colours, no link to bronze. A valid fallback. |
| dataviz slots 1 and 2 | `#2A78D6`, `#EB6834` | PASS, contrast WARN: `#EB6834` 2.92:1 | Needs relief labels |
| Loss as `danger` | `#2A6496`, `#8C3B2A` | PASS all. CVD 16.9 (deutan), normal 20.8. | `danger` is UI state, `loss` a data mark. The GNL theme PR can merge them. |
| Deeper pair | `#2E6A9E`, `#B8541F` | PASS all. CVD 18.4 (protan), normal 24.9. | A close alternative |
| Teal and brick | `#1F6E8C`, `#B5452F` | Chroma FAIL: `#1F6E8C` 0.087 | Reads grey |
| Magnitude as `faint` | `#6E7A70`, `#2A6496`, `#B5452F` | Normal FAIL: 13.1 against win | Too close to the blue |
| Lighter magnitude | `#8A938A`, `#2A6496`, `#B5452F` | Contrast WARN: 2.9:1 | Below 3:1 |

- Green and red is not a candidate. The style brief rules it out.
- `series-2` `#C0721C` is near `bronze` `#9A5B18`. They never share a job: `bronze` marks controls and selection, `series-2` a player's data. On the replay page the selected kind chips are bronze tint with a `bronze` border, and player 2's key is a 2 px `series-2` line beside the name.

### 6.6 Colour jobs

| Where | Job | Token |
|---|---|---|
| Opener share bars, hero-pick bars, histogram columns | one series, magnitude | `magnitude` |
| Replay APM lines, timeline player keys | identity of two players | `series-1` (lower `player_id`), `series-2` |
| Win-rate marks (openers, matchups) | polarity around 50 % | `win` above, `loss` below |
| Won and Lost in tables | state of one game | text in ink plus an 8 px dot in `win` or `loss` |
| Won on the replay page | state of one game | `mdi-trophy` plus "Won" in ink. No colour. |

- One hue means one thing per screen. Blue is `win` on search, openers and stats, and player 1 on the replay page, which shows no win colour.
- Decided: one-series magnitude takes `magnitude`, not `series-1` (F12). Why: `series-1` and `win` share a hex, and three screens show magnitude beside win and loss. This departs from dataviz `color-formula.md:22`.
- Text never wears a data colour (dataviz `marks-and-anatomy.md`). The old page colours result and win-rate text (`index.html:303, 415, 969-975`); the new app keeps text in ink and puts the colour on a mark.
- Win is blue, loss is red: the old page's pair swapped (`index.html:443-444`). gnl uses `success` and `error` (F9).
- Below the win-rate floor (section 13) the number is `text-muted` and no mark is drawn (`index.html:446, 969-975`).

## 7. Components copied from wc3-gym-frontend

| gnl path | Copy as | Change |
|---|---|---|
| `src/components/PlayerName.vue` | same | Keep the gnl order: flag slot, name, race (lines 10-14). Keep the empty `fp` span (line 11) in place of the flag. Keep `RaceIcon v-if="race"` (line 13) and `.race-gap` (line 14). Link or plain span. Drop `FlagIcon`, `player.country`, the panel link, the off-race and Host chips (lines 15-17). |
| `src/components/RaceIcon.vue` | same | Lookup by letter |
| `src/components/RaceSelect.vue` | same | `items` from the new `races.js`, `item-value` the letter, `defineModel()` (line 30) kept |
| `src/helpers/races.js` | `races.js` | Ids `H O N U R`, not `HU OC UD NE RANDOM` (api.md A5). Same five PNGs. |
| `src/components/GroupedTable.vue` | same, verbatim | Stats table views. `col.align === 'right'` drives number columns (line 13). |
| `src/App.vue:147-148, 153-174, 214` | the shell (section 3) | Three links, no groups, no avatar menu, no theme menu, no auth |
| `src/assets/base.css` | same, verbatim | none |
| `src/helpers/fetch-wrapper.js` | `api.js` | 5.1 |
| `src/components/DivisionBracketing.vue:121-122, 130, 136, 178-180` | `charts/useWidth.js` and the axis `watchEffect` | The pattern, not the component |
| `src/views/FantasyBetsView.vue:43-46` | `ReplayTable.vue` | `v-data-table-server` with `items-length` from `X-Total-Count` |

- `PlayerName`, `RaceIcon`, `RaceSelect` register globally, as gnl. Every player name on every screen is one `PlayerName`.
- A page moved into gnl needs only: the five chart tokens (unless the GNL theme PR adds them), `objects.js`, `format.js`, `ObjectIcon`, `ObjectPicker` and `public/icons/`.

## 8. Shared parts

### 8.1 Filter row (`FilterRow.vue`)

- One left-aligned row above the content on every list page (dataviz `interaction.md`).
- Controls in order: Race (`RaceSelect`, five races, clearable except on `/openers`), Opponent race, Map (`v-autocomplete` over `/filters` `maps`, game count as subtitle), Player (`v-autocomplete` over `/filters` `players`), Min and Max minutes (`v-text-field type="number"`, labels "Min min" and "Max min", 88 px wide). No season or team filter until the dims loader.
- A "Clear" text button shows when any key is set.
- 390 px: one `v-expansion-panels` titled "Filters" with a count badge. Open when no key is set, closed once a result shows. Fields in a two-column grid.

### 8.2 Replay table (`ReplayTable.vue`)

`v-data-table-server`, 25 rows, total from `X-Total-Count`. Search results and the openers panel use it. No column sorts: rows come in the API's one fixed order (api.md 2.4, A2).

| Column | Source (api.md 2.5) |
|---|---|
| Map | `map`, "Unknown map" when `""` |
| Matchup | `matchup` |
| Players | The `focus_player_id` player, "v", the other. No focus player: `players[]` order (by `player_id`). Each a `PlayerName`. The winner in `font-weight-medium`. |
| Length | `duration_ms` as `m:ss`, right-aligned |
| Result | The focus player: "Won" or "Lost" plus the dot (6.6). Blank when `won` is null or no focus player. Focus is Player 1 on search, the opener's owner in the panel. |
| GNL | `gnl` as "S{series_id} G{game_no}", text only, blank when null |
| File | `mdi-download` icon button to `download_url` (public base URL + `source_key`, stories D1); "No file" when null |

- Row key: `replay_id` plus `focus_player_id`. The openers list can hold one game twice, once per owner (api.md 2.5, 3.6).
- A row click goes to `/replays/:id`. The file button stops the click.
- Compact form (390 px, and the openers panel at every width): one cell per row. Line 1: focus player, "v", other. Line 2: map, length, result. File button at the right edge. Decided: PR 10 tries the Vuetify `mobile` prop of `v-data-table-server` first; custom one-cell rows only if it falls short.

### 8.3 States (`StateBlock.vue`)

| State | Look |
|---|---|
| Loading, first load | `v-progress-linear indeterminate` at the top of the content card (gnl: `RandomStatsView.vue:79`). The card keeps its height. |
| Loading, refetch | The previous render at 50 % opacity under the bar. No skeleton. Action buttons `:loading` and disabled, so a second click cannot submit twice. |
| Empty | One line that says what to change. Texts per screen below. |
| Error | 5.2 |

## 9. Screen: build-order search (`/search`)

### 9.1 Layout

- Order: filter row; two slot cards (Player 1: outcome, numbered steps, "Add step", "Without"; Player 2: name, outcome, steps, "Without"); the Search button at the right; the count ("62 games"); the replay table.
- md and wider: the two slot cards side by side. Race and opponent race come from the filter row, shown as the race icon in each card title.
- Decided: an empty URL lists every game (api.md 3.4). Why: the first view is never blank.

### 9.2 Controls

| Control | Maps to |
|---|---|
| Race, Opponent race, Map, Player, Min, Max | 4.1 |
| Player 1 outcome (`v-btn-toggle`: Won, Lost, Any) | `result` → `groups[0].result` |
| Player 2 name (`v-autocomplete`, `/filters` players) | `opp_player` → `groups[1].player` |
| Player 2 outcome | `opp_result` → `groups[1].result` |
| Step icon and name (opens the picker) | `subject_code`, and `event_type` from its kind |
| Step clock button (toggles the timing row; tinted when set) | none by itself |
| Within previous (s), disabled on step 1 | `within_previous_seconds` |
| Not before (m:ss) | `time_from_seconds` |
| Not after (m:ss) | `time_to_seconds` |
| Step remove (`mdi-close`) | removes the token |
| Add step (hidden at 8 steps) | opens the picker, appends a token |
| Search (`color="primary"`, `:loading`) | `router.push` with the draft |
| Table pager | `page` |

- Steps show as a numbered list, because the order is the query.
- A step reads as an order: the timing row says "ordered within 30 s", "ordered by 5:00".
- Reorder: remove and add again. Drag-to-reorder is skipped until players ask.
- Decided: timing entry is `m:ss` ("5" is 5:00). Why: opener timings are under a minute.

### 9.3 Object picker (`ObjectPicker.vue`)

A command-card grid, like the in-game build card: a name search field, kind tabs (Buildings, Units, Upgrades, Heroes, Skills, Items), then 40 px icons, 8 per row on desktop.

- Items come from `/mappings`. A tab shows one `kind`.
- Race filter: an item shows when `race` equals the slot race or `race` is null (api.md 3.2, the derived `race`). This keeps heroes, skills, upgrades and items for Night Elf, where a "code starts with the race letter" filter would empty them.
- Slot race `R`, or no slot race: every item shows, grouped in each tab under a race icon heading in the order H, O, N, U, then no race. Why: a derived `race` is never `R`, and a Random player's events carry `race = 'R'` but the rolled race's codes (queries.md §8 question 5). Measured 2026-09-11 on the dev set: `R` player-games rolled U 259, H 243, N 235, O 227, unknown 40; `R` building events start with `h` 5,755, `u` 4,562, `o` 3,495, `e` 3,470.
- The search field filters by `name` across all tabs. Enter picks the first hit.
- Skills group under a heading per hero, from the `hero` field.
- Each icon is a `v-btn` with `aria-label` = name and a name tooltip. Arrow keys move focus in the grid. Enter picks.
- Desktop: a `v-menu` anchored to the step. 390 px: a full-screen `v-dialog`, 6 icons per row at 44 px, so each tap target is at least 44 px.

### 9.4 Step-time chart (skipped)

Skipped: a per-step chart of when each step was ordered across the results. No API field feeds it (api.md 3.4) and no story asks. It would need a per-step `time_ms` on the search query.

### 9.5 States

| State | Text or look |
|---|---|
| Empty | "No game matches. Drop a step or widen the filters." (`index.html:289`) |
| 400 on a step | The alert, plus the red message on that step's control |
| Other | 8.3 and 5.2 |

### 9.6 390 px

The slot cards stack. Each step is one row: number, 28 px icon, name (ellipsis), clock, remove. The timing row opens under the step as three fields in one column. The Search button sticks to the bottom of the viewport while the builder is on screen.

### 9.7 Count, without, first hero (PR 16)

PR 15 adds the API fields (api.md 3.4). PR 16 adds these controls. The codec is 4.2.

| Form | Control | Label on screen | Review (stories.md story 1) |
|---|---|---|---|
| Minimum count | "At least" number field in the step's timing row, blank = 1 | "at least 5 Archer orders by 5:00" | Night Elf, `earc` at least 5 by 5:00: fixtures 1, dev set 1,100 |
| Without | "Without" chips under the steps, up to 3 codes, each from the picker. Button hidden at 3. | "no Ancient of Wonders ordered" | Night Elf, `eate`, without `eden`: 1, 573 |
| First hero | "First hero" switch on a hero step. Shown only for the `hero_trained` kind. | "first hero Demon Hunter" | Night Elf, first hero `Edem`: 3, 1,430 |

- The count counts orders, not finished units (replays record commands). Finished counts need stat-events and wait.
- Flagged repeats never count (`is_repeat = 1`, PR 2).

## 10. Screen: openers tree (`/openers`)

### 10.1 Layout

md and up: the tree (7 of 12 columns) and the selection panel (5 of 12, `position: sticky`) side by side. The sort toggle ("Most played", "Best win rate") sits right of the filter row.

- Tree: "{total} player-games", then columns Opener, Games (share bar), Win rate (header shows the domain ends), Avg min, replay button. A "Stopped here" row closes each open level.
- Panel: path tiles, figures, then the replay list (10.3).
- Dev-set example, Night Elf: root 2,730; `eate` 2,503 (92%, 50%, 15.3 min); `eaom` 2,294 (92%, 50%, 15.4); `etoa` 872 (38%, 51%, 16.1, 21 stopped); `eden` 816 (48%, 15.8); 59 stopped at `eaom`.

- An opener is a player's first six non-supply building orders (api.md 3.5), flagged repeats skipped. The column header reads "Opener (first building orders)".
- One `v-table`, not nested tables. Children splice in under their parent; closing a row removes its descendants (`index.html:949-967`). Sibling paths do not move.
- Each level is one `GET /openers?prefix=...` (api.md 3.5). Answers cache in a `Map` keyed by prefix for the life of the filter set.
- On load, every `open` prefix and every parent of `sel` loads in depth order, so a shared link rebuilds the same tree and panel.
- No `open` and no `sel`: the page follows the top row down to depth 3 and writes `open` and `sel` with `router.replace`. Cost: 3 requests in sequence on a cold page.
- Filter change: `sel` is trimmed to the part of the path that still exists, then written back with `router.replace` (as the mockup, `openers-tree.html:260-273`).

### 10.2 Controls and columns

| Control or column | Maps to |
|---|---|
| Race (required, not clearable, five races) | `race` |
| Other filters | 4.1 |
| Sort toggle | `sort=popular` or `sort=winrate` |
| Row click | sets `sel`. When `branches > 0`, also adds or removes the prefix in `open`. Depth stops at 6 (api.md 3.5, `index.html:448`). |
| Opener cell | Prefix icons (not text) at 28 px and 0.38 opacity, then the row's icon, its name, and a `v-chip size="x-small"` with `branches` (`index.html:370-372`). Indent 16 px per depth. Selected row: 3 px `primary` inset bar. |
| Games | `rows[].games`, plus the share bar (10.4) |
| Win rate | `wins / games` through `fmtPct`, plus the diverging mark (10.4). Below `WIN_RATE_FLOOR`: `text-muted`, no mark. The header shows the domain ends. |
| Avg min | `avg_minutes`, one decimal |
| Replay button (`mdi-play-box-multiple`, `aria-label` "Show games") | sets `sel`, moves focus to the panel's replay list; on phones scrolls to it |
| "Stopped here" row | `stopped`, shown when above 0. Children plus stopped sum to the parent (api.md A7). |

### 10.3 Selection panel

| Part | Fields | Source |
|---|---|---|
| Path tiles | Root tile: 40 px race icon, race name, `total`, "100%". One tile per code in `sel`: 40 px icon, name, `games`, share of its parent level's `total` via `fmtPct`. The last tile has the bronze tint. A tile click sets `sel` to that prefix. | cached level answers |
| Figures | `games` labelled "player-games"; win rate via `fmtPct` with the 10.4 mark (muted, no mark under the floor); `avg_minutes` labelled "avg minutes"; "stopped here". | the selected row. "Stopped here" is `stopped` of `GET /openers?prefix=<sel>` when `branches > 0`, else the row's `games`. |
| Replay list | Header: prefix icons at 20 px and "{n} player-games", n from `X-Total-Count`. `ReplayTable` compact form, 25 rows, paged by `page`. Focus player: the opener's owner. | `GET /openers/replays?prefix=<sel>` (api.md 3.6) |

- One count, one label: node and list both count player-games, so the list header equals the node (872 for Tree of Ages; api.md A14). A mirror game where both players hold the prefix lists twice, once per owner. The screen never shows a bare number.
- The list's progress bar sits inside the panel only. The tree stays live.

### 10.4 Inline marks

| Mark | Form | Scale | Palette | Tooltip |
|---|---|---|---|---|
| Share bar | Bar, magnitude down the whole column | `scaleLinear([0, root.total], [0, 64])` px, `root.total` = level-0 `total` | `magnitude` | "872 of 2,294 ordered Tree of Ages after Ancient of War (38%)" |
| Win-rate mark | Diverging bar from a 50 % centre tick | The shared win-rate domain (section 13) over every drawn row, mapped to `[0, 56]` px, centre 28. Header labels show the ends, e.g. "40%" and "60%". | `win` above 50 %, `loss` below | "3 wins of 5 games" |

- Both 6 px high, 2 px radius. Track: 1 px `rgb(var(--v-theme-line))`.
- The domain re-fits when rows open or close; the header labels change with it.
- The number stays in ink next to the mark.
- Decided: one share scale on `root.total`, not the parent. Why: on `[0, parent.total]`, Altar of Elders (2,503) and Ancient of War (2,294) draw the same length (each 92 % of its parent). Equal length must mean an equal count.

### 10.5 States

| State | Text or look |
|---|---|
| No race | Five large race buttons (48 px `RaceIcon` and name): Human, Orc, Night Elf, Undead, Random. A tap sets `race`. A Random tree mixes the four races' buildings (9.3). |
| Empty (`total` 0) | "No opener matches. Widen the filters." |
| Child loading | `v-progress-circular size="16"` in place of that row's chevron |
| Child error | The chevron becomes a retry icon. The alert shows the text. |
| Other | 8.3 and 5.2 |

### 10.6 390 px

- Order: filter panel, sort toggle (full width), path tiles and figures, the tree, the replay list. The panel parts split around the tree (mockup `openers-tree-mobile.png`).
- Path tiles scroll sideways in their own `overflow-x: auto` box.
- Tree columns: Opener, Games, Win rate, replay button. Avg min moves into the row tooltip. The name wraps under the icons.
- Indent 8 px per depth. Prefix icons 20 px; only the last two show, after a `…` icon.

## 11. Screen: stats (`/stats`)

One `GET /stats` feeds the page (api.md 3.7, A8). Every panel shows the same cohort.

### 11.1 Layout

- Order: filter row; the hero figure (6,567 games on the dev set); Matchups (left, tall) beside Game length and APM (stacked right); Hero picks full width below, five race blocks side by side.
- The hero figure is `games` in `.figure` with the caption "games". Story 3 asks the page to state the cohort size.
- Each panel has a chart and table toggle (`v-btn-toggle`, `mdi-chart-bar`, `mdi-table`). The table view uses `GroupedTable` with right-aligned numbers.
- md and wider as drawn. Below md one column.

### 11.2 Charts

| Panel | Form | Axes and scales | Palette | Tooltip |
|---|---|---|---|---|
| Matchups | Diverging bar, one row per unordered race pair ("Night Elf v Orc"). Not a 5 x 5 heatmap: the API sends each pair twice, and the palette has no red ramp. | y: `scaleBand` over pairs, rows 28 px. x: the shared win-rate domain over non-mirror rows at or above the floor, centre line at 0.5. `axisBottom` ticks at both ends, at 50 % and every 5 points, thinned by the density rule; labels via `fmtPct`. Race icons name the sides. Value label at the bar tip, `fmtPct(x, 1)`. | `win` when the first race is above 50 %, `loss` below. `decided` under 10: no bar, muted label. Mirror rows below a gap: games only (`wins` null), muted. | "Night Elf won 2 of 2 decided games v Orc. 2 games." Focusable rows. |
| Hero picks | Horizontal bar list, one block per race (small multiples), Random included. Shares pass 100 % (1-3 heroes per player, api.md 3.7), so no pie or stack. | Per block: rows 24 px with a 20 px hero icon and name. x: `scaleLinear([0, 1])` in every block. No tick axis: value at the tip via `fmtPct`. Block title: race icon and "{player_games} player-games". | `magnitude` | "Demon Hunter: 3 of 3 Night Elf player-games (100%)". Top 8 per race, then "Show all". |
| Game length | Column chart over ordered buckets | x: `scaleBand` over bucket index, labels "0-5" … "60+" (last bucket folds, api.md 3.7). y: `scaleLinear([0, max]).nice()`, integer ticks only. Every k-th bucket labelled, k from width. | `magnitude` | "5-10 min: 2 games". Hit area: full band height. |
| APM | Same component. Up to 21 buckets (width 25, cap 500). | Labels "0", "25" … "500+" | `magnitude` | "75-100 APM: 1 player-game" |

- Mark specs (dataviz `marks-and-anatomy.md`): bars at most 24 px thick, 4 px rounded at the data end, square at the baseline; 2 px surface gap; hairline grid in `line`; axis text `text-caption text-muted` with lining tabular digits.
- Decided: a symmetric win-rate domain. Why: the dev-set matchups run 45.3 % to 53.2 %. On `[0, 1]` at a 358 px plot, 53.2 % sits about 11 px from the centre; on 0.5 ± 0.1, about 57 px.

### 11.3 States

| State | Text or look |
|---|---|
| Empty (`games` 0) | "No game matches. Widen the filters." The four panels hide. |
| Panel with no data | An empty array. The panel says "No data". |
| Other | 8.3 and 5.2. On refetch the figure and charts hold at 50 % opacity. |

### 11.4 390 px

- One column. The hero figure sits left above the panels.
- Matchup rows keep 28 px. Race names shorten to icons. Mirror rows move to the table view.
- Bucket labels thin through the tick rule: 4 labels at a 358 px plot.

## 12. Screen: replay detail (`/replays/:id`)

One `GET /replays/{id}` (api.md 3.8, A9).

### 12.1 Layout

- Order: title (`map`) with a "Download replay" button (or "No file") at the right; players line; meta line; two player cards side by side; "APM per minute" with legend and chart/table toggle; "Build orders" with kind chips and chart/list toggle; chat.
- Fixture example `dcd3…`: Concealed Hill, 15:37, NvO, Patch 2.00, no GNL series. thanks#11187 (N, Won, 140 APM, `Edem` Demon Hunter level 4, skills `AEim` 2:22, `AEmb` 4:06, `AEmb` 6:40, `AEim` 11:54) v Okeanos#22605 (O, 89 APM, `Ofar` Far Seer level 3, skills at 2:17, 6:49, 9:58). Chat: 0:09 thanks#11187 "glhf".

### 12.2 Parts and fields

| Part | Field (api.md 3.8) |
|---|---|
| Title | `map`, "Unknown map" when `""` |
| Players line | two `PlayerName` (`{name} {race}`), "v" between, `mdi-trophy` after the winner |
| Meta line | `duration_ms` as `m:ss`, `matchup`, `version`, `gnl` as text "GNL S{series_id} G{game_no}" |
| Download | `download_url` (public base URL + `source_key`); "No file" when null |
| Player card | 2 px key in `series-1` or `series-2`, `PlayerName`, "Won" with `mdi-trophy` or "Lost", in ink. `apm` as the card figure. `heroes[]` in `slot` order: 40 px icon, name, "Level {final_level}". Under each hero its skill trail: the `hero_skill` events with that `hero_code`, 24 px icons in time order, `m:ss` under each. |
| APM chart | `players[].apm_per_minute` (12.4) |
| Timeline | `events[]`; the API already drops flagged repeats (12.3) |
| Kind chips | `v-chip-group multiple filter`: Buildings, Units, Upgrades, Heroes, Items. Query key `kinds`, all on by default. They filter both timeline views. |
| Chat | `chat[]`: time, `PlayerName`, `message` as text |

- Decided: the GNL series shows as text, no link. Why: the gnl route `/match/:id` is member-only and needs a match id the warehouse does not have. A link waits for the dims loader.
- Decided: hide private chat. Why: the route is public and cached for 1 hour. The API sends only `mode = 'All'` lines (api.md 3.8), so there is no "Private" chip.
- Names come from `/mappings` through `objects.js`. A code with no name shows the code.
- Skills sit in two places on purpose: the card answers "which skills, in what order"; the Heroes lane answers "when, against the build".

### 12.3 Build timeline

Section title "Build orders". Two views behind a `v-btn-toggle` (`mdi-chart-timeline`, `mdi-format-list-bulleted`). The chart is the default at md and up. The list is the default below md and is the chart's table view (section 13).

Flagged repeats: the API leaves out rows with `is_repeat = 1` (same code, same player, under 1000 ms after the previous same-code order, for tier halls, research and hero training; PR 2; api.md 3.8). `events[]` has no flag field, so neither view filters. The kept row carries the first order time.

Chart (`BuildTimeline.vue`), a swimlane:

| Item | Spec |
|---|---|
| Form | One block per player, lower `player_id` first. One lane per kind: Buildings, Units, Upgrades, Heroes, Items. A lane whose chip is off is not drawn. The Heroes lane holds `hero_trained`, `hero_skill`, `hero_retrained` (api.md 3.8). |
| Block header | 2 px key in `series-1` or `series-2` and `PlayerName` |
| x | Game minute, `scaleLinear([0, duration_ms / 60000], [gutter, width - 88])`. The same `gutter` as the APM chart. `axisBottom` on whole minutes as `m:00`, thinned by the density rule. A hairline grid line per tick. |
| Lane label | Kind name, `text-caption text-muted`, in the gutter |
| Marks | The event's 24 px command-card icon, centred on its time |
| Stacking | First fit per lane: an icon takes the first row whose last icon ends at least 1 px before its left edge, else a new row. Row pitch 24 + 3 px. Lane height = rows × 27 + 5 px, at least one row. A hairline separates lanes. |
| Hit targets | The icon: 24 px, `tabindex="0"`, `alt` = "{name} ordered at m:ss" |
| Tooltip | Hover and focus: the name, then "Ordered at m:ss". A skill: "{hero} skill at m:ss". `hero_trained`: "Trained by m:ss" (the first cast, api.md 3.8). `hero_retrained`: "Retrained at m:ss". |
| Width | At least 760 px. Below that the chart scrolls in its own `overflow-x: auto` box. |

List (the table view):

- md and up: one list on one time axis. Player 1 left, player 2 right, time in a centre gutter. Events at the same `time_ms` share a row. Column heads are the two `PlayerName`s with keys.
- Below md: two `v-tabs`, one per player (`PlayerName` in each tab). Each tab: time, 24 px icon, name. A hero row carries its skill trail.

### 12.4 APM chart

| Item | Spec |
|---|---|
| Form | Line chart, two series: change over time for two players |
| Axes | x: game minute, `scaleLinear([0, n - 1])`, `ticks(max(2, round(width / 90)))`. Left edge at the timeline's `gutter`. y: `scaleLinear([0, max]).nice()`, 4 ticks, hairline grid. |
| Marks | `d3-shape` `line()`, 2 px, round join and cap. 8 px end dot with a 2 px surface ring. |
| Identity | Legend above the plot: 2 px line key and `PlayerName`. Direct labels at the line ends; they drop when the end values sit within 16 px. |
| Palette | `series-1` for the lower `player_id`, `series-2` for the other |
| Tooltip | A vertical crosshair snaps to the nearest minute. One tooltip lists both APMs, value first. The plot is focusable; Left and Right move the crosshair. |
| Size | 200 px plot plus a 28 px x-axis band. Width from `useWidth`. |
| Table view | Minute rows with both APM values |

### 12.5 States

| State | Text or look |
|---|---|
| Unknown id | "No game with this id" and a link to Search. No chart frame. |
| Loading | Progress bar. The page reserves the header height only. |
| No chat | The chat section hides. |
| Other | 5.2 |

### 12.6 390 px

- Player cards stack. Skill trails wrap.
- The timeline opens on the list, in two tabs. The chart stays one toggle away, in its scroll box.
- The APM chart keeps full width. Direct labels drop; the legend stays.

## 13. Chart and format rules that apply everywhere

| Rule | How |
|---|---|
| Real pixels | `useWidth(el)`: a `ref` from a `ResizeObserver` on the chart's parent, clamped to 280 px (gnl: `DivisionBracketing.vue:121-122, 130`). `<svg>` `width` and `height` in pixels. No `viewBox` stretching. |
| Vue owns marks | `v-for` against `computed` scales (gnl: `DivisionBracketing.vue:136`) |
| d3-axis owns one `<g>` | `watchEffect(() => select(g).call(axisLeft(y)...))` (gnl: `DivisionBracketing.vue:178-180`). Axis colours from CSS on `.axis` with tokens. |
| Tick density | `max(2, round(width / 90))` ticks (gnl: `DivisionBracketing.vue:180`) |
| Win-rate domain | `[0.5 - d, 0.5 + d]`, `m` = the largest `abs(rate - 0.5)` over drawn marks (at or above the floor), `d = min(0.5, max(0.1, ceil(m / 0.05) * 0.05))` (`stats.html:196-197`). The ends are always labelled. |
| Percent format | `fmtPct(x, digits = 0)` in `format.js`: `new Intl.NumberFormat('en', { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(x)`. "50%", "53.2%", no space. One decimal only on stats matchup value labels. |
| Win-rate floor | One exported constant, `WIN_RATE_FLOOR = 10`, in `format.js`. Neither it nor the server literal is on the wire (api.md 3.5). Under it, openers rows, the selection panel and matchup rows show a muted number and no mark. Decided: keep it in two places, the server literal in the `/openers` `winrate` sort (api.md 3.5, queries.md 3.5) and this constant, pinned by a golden and by `query.test.mjs`. |
| Order wording | Any count or time of an order reads "ordered" / "orders". Flagged repeats are skipped in every count and hidden on the timeline. |
| Container height | Plot height plus the axis band, so labels never cause a nested scroll |
| Tooltip | One `ChartTooltip.vue`: an absolutely placed `v-sheet` in the chart box. Text via interpolation. Opens on `pointermove` and `focus`; a tap opens it on a phone, a tap outside closes it. |
| Hit targets | A transparent rect over each bar's whole band, at least 24 px |
| Keyboard | Bars and rows take `tabindex="0"` and an `aria-label` with the tooltip text |
| Table view | Every chart has one (story 3) |
| No prose on screens | Titles and axis labels only |

## 14. Serving, dev and CI

This section is the frontend part of plan.md. rust.md §15 hands the nginx change here.

### 14.1 Serving on the box

Today `compose.yaml:75-84` mounts `./frontend` into `nginx:alpine`, and its comment says the browser queries ClickHouse directly (`compose.yaml:75-77`). Both stop being true.

`infrastructure/docker/Dockerfile.ui`:

```dockerfile
# The replay pages: the Vite build, served by nginx with the /api/ proxy.
FROM node:22-alpine AS build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

FROM nginx:alpine
COPY infrastructure/docker/nginx-ui.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/dist /usr/share/nginx/html
```

`infrastructure/docker/nginx-ui.conf`:

```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  location /api/ { proxy_pass http://api:8000/; }  # the trailing slash strips /api (api.md 2.1)
  location / { try_files $uri $uri/ /index.html; }  # history mode
}
```

compose `ui` service, replacing `compose.yaml:75-84`:

```yaml
  # The replay pages: the built Vite app, with /api/ proxied to the api service.
  ui:
    build:
      context: .
      dockerfile: infrastructure/docker/Dockerfile.ui
    networks: [default, chapi]   # the tunnel reaches it on default; it reaches api on chapi (rust.md §8)
    ports:
      - "127.0.0.1:8080:80"
    depends_on:
      - api
    restart: unless-stopped
```

- Port 8000, the service name `api` and the `chapi` network come from rust.md §8 and §15.
- Node 22 is my pick; gnl `package.json:1-34` names no engine.
- `.dockerignore` gains `**/node_modules/` and `frontend/dist/`.
- Loopback port only, as today (`compose.yaml:80-81`).

### 14.2 Dev

- `vite.config.js` proxy, as gnl `vite.config.js:14-20`: `'/api'` to `process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8000'`, `changeOrigin: true`, `rewrite: p => p.replace(/^\/api/, '')`.
- just recipes, next to rust.md 16's `api`:

```just
# Vite dev server; /api goes to the API on 127.0.0.1:8000 (run `just api` too)
ui:
    npm --prefix frontend run dev

# install and build frontend/dist
ui-build:
    npm --prefix frontend ci
    npm --prefix frontend run build
```

- rust.md 16's `test` recipe gains `npm --prefix frontend test`, so `just test` runs every test.
- stories.md "Review" step 2 reads: `just api` and `just ui`.

### 14.3 CI

A new job in `infrastructure/ci.yml`. Daniel copies the file to `.github/workflows/` (`ci.yml:1`).

```yaml
  ui:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
      - run: npm test
      - run: npm run build
```

- `image` job: add a `docker/build-push-action` step for `Dockerfile.ui`, tagged `ghcr.io/warcraft-gym/wc3-gym-warehouse-ui:latest` and `:${{ github.sha }}`, as `ci.yml:58-65`.

## 15. Design choices

All decided.

| # | Choice | Decided | Why |
|---|---|---|---|
| F1 | Colours | The GNL style as named tokens, validated chart tokens (6.1, 6.5) | Daniel set the style 2026-09-11. Cost: `tokens.js`, the theme block, `style.css`. |
| F2 | Step codec | Readable keys per field and a short step grammar (4.2), not base64 JSON | A link pasted in Discord stays legible. The keys equal the API names. One parser, one test file. |
| F3 | Win-rate display | Ink number plus a diverging mark on a symmetric domain (10.4, 11.2, 13) | Coloured text fails contrast and the dataviz text rule. On `[0, 1]` over 56 px one point is about 0.56 px. |
| F4 | Picker | Command-card grid with kind tabs and name search (9.3) | Players know the icons better than the names. Cost: grid keyboard focus, about 40 lines. |
| F5 | Replay timeline | Swimlane on the APM chart's minute axis, the list as its table view (12.3) | Shows tempo and idle stretches; an APM spike lines up with a build. Cost: first-fit stacking (about 30 lines), a scroll box under 760 px. |
| F6 | Openers state | `open` and `sel` keys (4.3) | A shared link is useful only with its path open. Cost: up to 6 requests in sequence, each cached 60 s. |
| F7 | Server data cache | The browser HTTP cache (api.md 2.7) plus a per-page `Map` for opener levels. No Pinia. | A store duplicates the tiers and adds staleness rules. |
| F8 | Icon map | Module import of `icons.json` (646 entries) | One less request, no empty-icon frame |
| F9 | Win and loss colours | Proposed `win` `#2A6496`, `loss` `#B5452F`; final pair open (section 16, question 3) | Passes every check on `surface` (6.5). gnl's `success`/`error` (gnl: `HeadToHead.vue:83`, `FantasyBetsView.vue:466-467`, `MatchDetailsView.vue:274`) is green and red, which the brief rules out; `#4CAF50` has 2.78:1 on white. |
| F10 | App shell | The gnl shell (section 3) | Copied pages land in the same frame. The title stays at 390 px. |
| F11 | Openers replays | Selection panel beside the tree with `sel` (10.3), not a dialog | The tree stays in view; path tiles show the share at each step. |
| F12 | One-series magnitude | `magnitude` `#7D877E` (6.6) | `series-1` equals `win`. Passes against win and loss: CVD ΔE 10.4, normal 16.2. |
| F13 | Shipping | Multi-stage `Dockerfile.ui` built in CI, pushed to ghcr (14.1, 14.3) | The box needs no Node and no manual build. CI proves the build. |
| F14 | Fonts in Vuetify | CSS overrides in `style.css` (6.3), not Vuetify SASS settings | Three rules, no `sass` or `vite-plugin-vuetify` (gnl has neither). Ceiling: the breakpoint type classes keep Roboto; change when a view needs them. |

Also decided (one line each): race ids are the letters `H O N U R` (api.md A5); `R` is a fifth race; private chat hidden; `m:ss` timing; empty `/search` lists every game; phone table tries the Vuetify `mobile` prop (8.2); fallback glyph for the 3 icon-less codes (6.4); win-rate floor in two places pinned by tests (13); legacy page at `/legacy/` until PR 14 (section 2); page PR shots replace the mockups (section 17); GNL series as text (12.2); D2 (URL holds state) and D3 (two Review bases) confirmed.

## 16. Open questions

Only these stay open.

| # | Question | Options | Recommend | Decide at |
|---|---|---|---|---|
| 1 | Public ingress, GNL backend search path, hosting | Ingress: tunnel to ClickHouse 8123 with a password; or tunnel to the `ui` nginx. Backend search: the backend calls ClickHouse; or the API's `POST /search`. Hosting: the box through nginx; or pages copied into gnl (gnl's base path and history fallback). | Tunnel to the `ui` nginx with one Cloudflare rate-limit rule per IP on `/api/*` (the plan's rule limits not checked). The backend uses `POST /search`, because 8123 is then not public. Host on the box first; copy pages into gnl later. Today the tunnel reaches ClickHouse only (`infrastructure/cloudflared/config.yml.example`, `compose.yaml:116-119`). | PR 10 |
| 2 | When to design a dark theme | With the GNL theme PR; or later | With the GNL theme PR. It then needs a `dark` theme block with its own steps, the 6.5 runs on the dark surface, a pre-paint script and a theme control in the app bar. | GNL theme PR |
| 3 | The final win/loss pair (and `series-1`, `series-2`) | Proposed `#2A6496` / `#B5452F` (players `#2A6496` / `#C0721C`); the 6.5 alternates; or merge `loss` into `danger` | The proposed pair. Propose it to gnl as app-wide; until then copied pages show a blue win beside gnl's green `success` chips. | GNL theme PR |

## 17. Mockups against this file

Decided: each page PR's Playwright shots (light only) replace the mockups for Review (plan.md). Where a mockup and this file differ, this file wins. The page PRs must close these gaps in their shots:

| Mockup | Gap | Closed by | Section |
|---|---|---|---|
| all four | No gnl shell: no inline nav links with a drawer below md | PR 10 | 3 |
| `build-order-search.html` | With slot race `R` or no race, the picker does not group icons under race headings. No "ordered" wording in the timing row. | PR 11 | 9.2, 9.3 |
| `openers-tree.html` | The replay list sits in a `v-dialog`, not the selection panel with path tiles and figures. The URL holds no `open` or `sel`. | PR 12 | 10.1-10.3, F6, F11 |
| `replay-detail.html` | The timeline is the list only; the swimlane (the md-and-up default) is missing. Tooltips do not say "Ordered at". Flagged repeats are not hidden. | PR 14 | 12.3, F5 |
| none | The count, without and first-hero controls have no mockup | PR 16 | 9.7 |
