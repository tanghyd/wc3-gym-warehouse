# vendor/w3grs — patched copy of the `w3grs` 0.2.3 crate

Verbatim crates.io source (MIT, © wakamex — LICENSE retained; `fixtures/` and
`tests/` dropped, they aren't needed for a path dependency) plus ONE local
patch, applied via `[patch.crates-io]` in `../Cargo.toml`:

**Keep unknown rawcodes.** Upstream classifies every string-encoded build/train
action by looking the rawcode up in its embedded melee mapping tables
(`mappings.rs`); a code found in no table — i.e. every custom-map object, such
as Legion TD towers — was silently dropped. The patch adds a fifth bucket,
`players[].unknown: {summary, order}`, filled by trailing `else` branches in
`handle_stringencoded_item_id` / `handle_stringencoded_order_id`
(`src/player.rs`), serialized with `skip_serializing_if` so it is omitted
when empty.

Melee replays are NOT immune: upstream also deliberately ignored a few
known-code order classes — hero training (`Obla`, `Edem`, …; heroes are
tracked separately in `players[].heroes`) and neutral-shop/mercenary orders
(`nitp`, …) — and those now land in `unknown` too. The parity goldens were
therefore regenerated (the documented bless procedure in `tests/parity.rs`);
the diff is purely additive `unknown` buckets. Downstream, the loader keeps
melee analytics clean by only *naming/serving* unknown codes observed in
non-melee replays; the melee event surfaces never query `event_type='unknown'`.

Not upstreamed (yet): it changes the crate's public JSON surface, and upstream
parity-with-w3gjs is w3grs's stated contract; revisit if w3gjs itself grows the
bucket. Diff against pristine 0.2.3 to see the exact patch:

    diff -r ~/.cargo/registry/src/index.crates.io-*/w3grs-0.2.3/src src
