---
type: Domain Concept
title: Duplicates
description: "A replay id hashes the game's facts, a game key groups the files of one game, and the most complete copy stands for it."
tags: [data]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: replays
    resource: ../../../dbt/models/marts/replays.sql
    title: game_key and duplicate_of
  - id: landing
    resource: ../../../dbt/models/landing/raw_replays.sql
    title: The pick per replay id
---

`replay_id` is a hash of the random seed, the player names and the game name, so two saves of one game by one client share an id and `raw_replays` keeps one document for it: the highest parse version, then the longest game, then the newest file.

One game can still arrive as two files with different ids, such as a service copy and a player's copy. They share `game_key` (the random seed and the sorted names). The most complete copy stands for the game: the longest, then the one with the most orders and skill points, then the lowest id. `replays.duplicate_of` points the others at it and is empty on the copy itself.

Only `player_games` leaves the duplicates out, so counts and searches see each game once. The per-replay tables keep every file, because the replay page opens a file by id. A dbt test holds that every game key has one standing copy and every duplicate points at it.
