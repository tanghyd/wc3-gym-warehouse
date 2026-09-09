//! Emit one ClickHouse-ready `w3g.mappings` record per mapping (item / unit /
//! building / upgrade / hero_skill / hero) as a JSONEachRow file.
//!
//! Port of the former `export-mappings.ts`: it enumerates w3grs's mapping tables
//! (the same data w3gjs ships) and applies the same schema knowledge — prefix
//! conventions (`i_`/`u_`/`p_`/`a_`/`b_`), the `<Hero>:<Ability>` split for hero
//! skills, and the ABILITY_TO_HERO ↔ HERO_ABILITIES join that synthesises hero-
//! unit rows. The SQL loader stays oblivious to all of it.
//!
//! Row ORDER is irrelevant: the file is loaded `FORMAT JSONEachRow` into a
//! ReplacingMergeTree keyed by code, so only the row SET matters (verified equal
//! to the TS output). Struct field order matches the old `JSON.stringify` key
//! order, so individual lines are byte-identical too.
//!
//! usage: export-mappings <out.json>
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::process;

use serde::Serialize;
use w3grs::mappings::{ABILITY_TO_HERO, BUILDINGS, HERO_ABILITIES, ITEMS, UNITS, UPGRADES};

// Base-tier supply structures excluded from the opener trie by default. Codes,
// not names, so the flag is stable against upstream display-string churn — and
// base tier only (upgrade-tier Undead structures are towers, not supply).
// Burrow (otrb) is intentionally absent: it is also a garrison / upgrade target
// and Burrow rushes are a real strat. (Verbatim policy from export-mappings.ts.)
const SUPPLY_BUILDING_CODES: &[&str] = &["hhou", "emow", "uzig"];

#[derive(Serialize)]
struct Row {
    code: String,
    name: String,
    kind: &'static str,
    race: &'static str,
    hero: String,
    is_supply_building: u8,
}

fn race_for(code: &str) -> &'static str {
    match code.chars().next().map(|c| c.to_ascii_lowercase()) {
        Some('h') => "human",
        Some('o') => "orc",
        Some('u') => "undead",
        Some('e') => "night_elf",
        Some('n') => "neutral",
        _ => "",
    }
}

fn strip<'a>(value: &'a str, prefix: &str) -> &'a str {
    value.strip_prefix(prefix).unwrap_or(value)
}

fn rows_from_table(entries: &[(&str, &str)], kind: &'static str, prefix: &str) -> Vec<Row> {
    entries
        .iter()
        .map(|&(code, raw)| {
            let value = strip(raw, prefix);
            // hero_skill values are "<Hero>:<Ability>"; everything else is a name.
            let (hero, name) = match (kind == "hero_skill").then(|| value.find(':')).flatten() {
                Some(i) => (value[..i].to_string(), value[i + 1..].to_string()),
                None => (String::new(), value.to_string()),
            };
            let is_supply_building =
                (kind == "building" && SUPPLY_BUILDING_CODES.contains(&code)) as u8;
            Row {
                code: code.to_string(),
                name,
                kind,
                race: race_for(code),
                hero,
                is_supply_building,
            }
        })
        .collect()
}

/// ABILITY_TO_HERO: ability_code → hero_unit_code. HERO_ABILITIES: ability_code →
/// "a_<Hero>:<Ability>". Joining yields hero_unit_code → Hero (e.g. "Hamg" →
/// "Archmage") so hero-unit codes resolve in the event_log view. First mapping
/// per hero-unit wins (all of a hero's abilities yield the same hero name).
fn synthesize_hero_units() -> Vec<Row> {
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for &(ability_code, hero_unit_code) in ABILITY_TO_HERO {
        if seen.contains(hero_unit_code) {
            continue;
        }
        let raw = HERO_ABILITIES
            .iter()
            .find(|&&(c, _)| c == ability_code)
            .map(|&(_, v)| v)
            .unwrap_or("");
        let hero_name = strip(raw, "a_").split(':').next().unwrap_or("");
        if hero_name.is_empty() {
            continue;
        }
        seen.insert(hero_unit_code);
        rows.push(Row {
            code: hero_unit_code.to_string(),
            name: hero_name.to_string(),
            kind: "hero",
            race: race_for(hero_unit_code),
            hero: String::new(),
            is_supply_building: 0,
        });
    }
    rows
}

fn main() {
    let out = match std::env::args().nth(1) {
        Some(p) => p,
        None => {
            eprintln!("usage: export-mappings <out.json>");
            process::exit(2);
        }
    };

    let mut rows = Vec::new();
    rows.extend(rows_from_table(ITEMS, "item", "i_"));
    rows.extend(rows_from_table(UNITS, "unit", "u_"));
    rows.extend(rows_from_table(BUILDINGS, "building", "b_"));
    rows.extend(rows_from_table(UPGRADES, "upgrade", "p_"));
    rows.extend(rows_from_table(HERO_ABILITIES, "hero_skill", "a_"));
    rows.extend(synthesize_hero_units());

    let mut buf = String::with_capacity(rows.len() * 64);
    for r in &rows {
        buf.push_str(&serde_json::to_string(r).expect("serialize mapping row"));
        buf.push('\n');
    }
    if let Err(e) = fs::write(&out, &buf) {
        eprintln!("write {out}: {e}");
        process::exit(1);
    }

    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for r in &rows {
        *counts.entry(r.kind).or_default() += 1;
    }
    let summary: Vec<String> = counts.iter().map(|(k, v)| format!("{k}={v}")).collect();
    eprintln!("wrote {} rows → {out}  ({})", rows.len(), summary.join(", "));
}
