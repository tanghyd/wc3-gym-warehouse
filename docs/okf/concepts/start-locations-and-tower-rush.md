---
type: Domain Concept
title: Start locations and the tower rush
description: "A player's start is read from where he builds, with three rules; a forward building stands under 3,000 map units from the opponent's start."
tags: [data, api]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: starts
    resource: ../../../dbt/models/marts/player_starts.sql
    title: The three rules
  - id: forward
    resource: ../../../api/compile.py
    title: FORWARD_UNITS and forward_condition
---

# Start locations

A replay names no start location. The `start_locations` seed holds each map's starts, and `player_starts` names each player's start in a 1on1 by three rules:

1. The start within 1,500 map units of his earliest building placement that lies near any start (`first building` when that is his first placement, else `later building`).
2. Else, on a two-start map, the start his opponent holds by rule 1 does not (`opponent`).
3. Else `none`: no coordinates.

`start_source` on the row names the rule. Two players never share a start; a dbt test holds that.

# The tower rush

A building step with `forward` keeps only placements under 3,000 map units from the opponent's start (`player_games.opp_start_x`, `opp_start_y`), so its count counts forward placements. A player whose opponent has no start has none. The distance is fixed, not per map.
