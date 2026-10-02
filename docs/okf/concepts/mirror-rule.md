---
type: Domain Concept
title: The mirror rule
description: "A game both players fit counts once, from the lower player slot, and adds no win or loss."
tags: [api, web]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: api
    resource: ../../../api/compile.py
    title: shown, seats and the search tally
  - id: readme
    resource: ../../../README.md
    title: The query API section
---

Every count the API answers is games, not player seats. `player_games` has two rows per game, one per player. When a question's conditions hold for both players (both are Night Elf, or both opened the same way), the game is a mirror: it counts once, shown from the lower player slot, and it adds no win or loss, because either player could sit on the asked side. `wins` and `losses` count only the games that fit one way, and are null when every game in a row is a mirror.

`POST /query`, `POST /search` and `POST /strategies/stats` apply the rule the same way; a page reads totals from the API rather than adding rows up, because a game whose two players fall in two rows counts in both.
