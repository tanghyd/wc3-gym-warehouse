# db/w3g/seed — committed reference rows loaded by scripts/pipeline.sh

`custom_object_names.ndjson` — `w3g.mappings` rows (`kind='unknown'`) naming
custom-map object rawcodes, so custom-mode build events resolve to display
names instead of bare 4-char codes. Each row also carries `category`
(ui-menu / builder / tower / upgrade / item / other — derived from the map's
object data; see `scripts/extract_custom_objects.py`, which regenerates this
file AND `services/api/src/api/custom_icon_art.json` from MPQ-extracted map
dirs). Source: the maps' own object data (`war3map.wts` + the object files,
sniffed by content — protected Team OZE maps anonymize filenames) out of the
`.w3x` MPQ via MPQEditor; the W3Champions launcher's map cache is a ready
local source. Covers the Legion TD 11.2c-hf1 **and** 11.4b Team OZE variants
(PHCC / PRACMI / PRCCX3 + 11.4b pracmi / prccxmix3). Codes with no object-data
row in any harvested map — e.g. `R0X3`, a trigger-created runtime upgrade whose
only trace is an orphaned `war3map.wts` comment — stay raw-code backstops by
design (the extractor reads units/items/upgrades object files, not triggers).
Append rows for other custom maps as they are ingested (codes are
map-family-scoped by convention — collisions across map families would need
a namespacing rethink). Codes observed in events but absent here still work
everywhere, displaying as their raw code — or, for standard WC3 objects the
parser routes to 'unknown' (hero trains, shop items), as their canonical
melee name (the loader backstop joins the melee mappings).
