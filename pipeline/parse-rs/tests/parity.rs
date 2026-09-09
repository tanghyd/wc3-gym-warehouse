//! Parity goldens — the regression net for "field-faithful drop-in".
//!
//! The old TS `parity.ts` died with the w3gjs pipeline; without this, every
//! w3grs bump silently re-asserts an unverified claim. Each fixture .w3g in
//! `pipeline/parse-rs/fixtures/` has a committed golden of its parsed doc;
//! this test reparses and diffs as JSON *values* (w3grs serialises its summary
//! maps in hash order, so bytes are not comparable — values are).
//!
//! Volatile-field policy (stated once, here): `parseTime` — wall-clock parse
//! duration, the only non-content field — is stripped from both sides.
//!
//! Blessing a deliberate parser change = regenerate the goldens:
//!   pipeline/parse-rs/target/release/parse /tmp/g pipeline/parse-rs/fixtures/*.w3g
//!   then rewrite tests/goldens/*.json as sorted-key JSON (json.dump
//!   sort_keys=True, indent=1) and review the git diff — that diff IS the
//!   parser-change review.

use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

fn strip_volatile(doc: &mut Value) {
    if let Some(obj) = doc.as_object_mut() {
        obj.remove("parseTime");
    }
}

#[test]
fn fixtures_match_goldens() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture_dir = manifest.join("fixtures");
    let golden_dir = manifest.join("tests/goldens");

    let stems = |dir: &Path, ext: &str| -> BTreeSet<String> {
        fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
            .filter_map(|e| {
                let p = e.unwrap().path();
                (p.extension().is_some_and(|x| x == ext))
                    .then(|| p.file_stem().unwrap().to_string_lossy().into_owned())
            })
            .collect()
    };

    // 1:1 — a fixture without a golden would silently skip; a golden without
    // a fixture is dead weight. Both fail here.
    let fixtures = stems(&fixture_dir, "w3g");
    let goldens = stems(&golden_dir, "json");
    assert_eq!(
        fixtures, goldens,
        "fixture .w3g and tests/goldens/*.json must pair 1:1 (see header for regeneration)"
    );
    assert!(!fixtures.is_empty(), "no fixtures found — wrong path?");

    for stem in &fixtures {
        let bytes = fs::read(fixture_dir.join(format!("{stem}.w3g"))).unwrap();
        let parsed = w3warehouse_parse::parse_replay(&bytes)
            .unwrap_or_else(|e| panic!("{stem}: parse failed: {e}"));
        let mut actual: Value = serde_json::from_str(&parsed.json).unwrap();
        let mut expected: Value =
            serde_json::from_str(&fs::read_to_string(golden_dir.join(format!("{stem}.json"))).unwrap())
                .unwrap();
        strip_volatile(&mut actual);
        strip_volatile(&mut expected);

        // Per-key compare so a drift names its field instead of dumping two docs.
        let (a, e) = (actual.as_object().unwrap(), expected.as_object().unwrap());
        let keys: BTreeSet<_> = a.keys().chain(e.keys()).collect();
        for k in keys {
            assert_eq!(
                a.get(k),
                e.get(k),
                "{stem}: field `{k}` drifted from golden"
            );
        }

        // The lifted convenience fields must agree with the doc they were lifted from.
        assert_eq!(Some(parsed.replay_id.as_str()), e["id"].as_str(), "{stem}: lifted id");
        assert_eq!(Some(parsed.replay_type.as_str()), e["type"].as_str(), "{stem}: lifted type");
    }
}
