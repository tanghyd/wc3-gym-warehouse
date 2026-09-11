# db/w3g/seed — committed reference rows

`custom_object_names.ndjson` — `w3g.mappings` rows (`kind='unknown'`) naming
custom-map object rawcodes, so custom-mode build events resolve to display names
instead of bare 4-char codes. Each row also carries `category` (ui-menu /
builder / tower / upgrade / item / other), derived from the map's own object
data. Loaded by `just local::mappings` after the melee export.

Codes seen in events but absent here still work everywhere, displaying as their
raw code.
