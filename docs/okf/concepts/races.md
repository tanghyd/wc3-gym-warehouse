---
type: Domain Concept
title: Races
description: "A player's race is the one he played; a Random pick keeps a flag, and the API speaks nine race values."
tags: [data, api]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: macro
    resource: ../../../dbt/macros/race_code.sql
    title: The race code macro
  - id: api
    resource: ../../../api/compile.py
    title: race_value
---

# The played race

`race` on every player row is the race the player played: HU, OC, NE or UD. A player who picked a race played it. A player who picked Random played the race the parser detected, else the race of his first building or unit order; with neither, he keeps RANDOM. `random` is 1 when the player picked Random, so Night Elf with `random` 1 is a Random player who rolled Night Elf. `matchup` is built from the played races.

# The race values

The API and the pages speak one value per combination: `HU`, `OC`, `NE`, `UD` for a picked race, `RH`, `RO`, `RN`, `RU` for a Random player who rolled it, and `R` for a Random player with no played race. A filter on a side takes any list of them.
