# wc3-gym-warehouse

Replay analytics for the GNL site. ClickHouse on one Hetzner box, replays in a Cloudflare R2 bucket, reached from the GNL backend through a Cloudflare Tunnel.

The design and build order are in [PLAN.md](PLAN.md).

Same rules as the other Warcraft-Gym repos: branch, PR to `main`, squash merge.

## Run it

Copy `.env.example` to `.env` and fill in the bucket credentials, then:

```
just up                 # clickhouse, the schema, and the drain
just mappings           # load the WC3 name mappings once
just drain-once         # parse everything new in replays/
just backfill-bucket    # load the parsed prefix out of the configured bucket
just ch                 # a clickhouse-client shell
```

`just up` also serves the search page at http://localhost:8080. Pick a race, a
map and an ordered list of what a player built, and it lists the games that
match. The page reads ClickHouse over HTTP from the browser, so there is no API
to run; the SQL it generates is on the second tab.

Naming a player narrows either tab to the games they played. On the search tab
the name sits on a player slot, so it says which side of the game did the build.

The Openers tab reads the same data from the other end. It shows every opener
this race played, one building at a time, with games, win rate and average
length. Click a row to open the next building; the paths either side stay on
screen. The replay button lists the games behind that row.

The clock on a step adds timing. "Within previous" caps the seconds between that
step and the one above it. "Not before" and "not after" pin the step to a window
in game time. A step with no timing may sit any distance from its neighbour.

The page follows wc3-gym-frontend: stock Vuetify light and dark themes with the
same three-way theme menu, that repo's `base.css` table polish, and its
`RaceSelect` and `PlayerName` components mirrored so a race is drawn the same
way in both apps. `frontend/race-icons/` holds its race marks.

`frontend/icons/` holds the 530 command-card images the picker draws, copied
from w3warehouse and cut to the objects this schema names. `frontend/icons.json`
maps an object code to its file.

`just backfill-bucket` builds the URL from `.env`. Pass your own glob to
`just backfill '<url>'` to load a narrower set, such as one date.

`docker compose --profile local up -d` adds a MinIO to stand in for the R2
bucket; `--profile prod` adds the Cloudflare Tunnel.

On a machine with no Docker, `infrastructure/local/` starts the same ClickHouse
and MinIO straight on the host.

## How it fits together

The GNL backend writes a reported replay to `replays/<series id>/game<n>.w3g` in
the bucket and keeps the public download URL. Every key starts with the Vercel
environment that wrote it (`app/services/r2.py`), so the real key is
`preview/replays/435/game1.w3g`. Set `W3WAREHOUSE_S3_PREFIX` to that segment and
`replays/`, `parsed/` and `status/` all move under it together, which keeps one
environment's parsed output out of another's. The drain lists that prefix, parses
each new or changed file, and writes the parsed document to
`parsed/v2/dt=<date>/<replay id>.json` with the series and game number in a `gnl`
field. It never moves or deletes the raw file. `backfill.sql` loads the parsed
prefix into ClickHouse, where the materialized views in `db/w3g/views.sql` fan it
out to per-player and per-event tables and the opener rollup.
