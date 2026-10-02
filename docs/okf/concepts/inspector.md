---
type: Domain Concept
title: The replay inspector
description: "The pages of the Next.js app, what each reads from the API, and the rule that the URL holds the view."
resource: ../../../web/src/app
tags: [web]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: app
    resource: ../../../web/src/app
    title: The pages
  - id: api
    resource: ../../../web/src/lib/api.ts
    title: The server reads
---

| Page | Shows | Reads |
|---|---|---|
| `/` Replays | the build-order search: two sides, a step editor, the list of games with each side's player, race, result and heroes, the summary and the scope | `/catalog`, `/objects`, `/search`, `/strategies` |
| `/replays/{id}` | one game: the players, the result, the timeline of orders and skill points per player, the chat | `/replays/{id}` |
| `/strategies` | every preset with its games, wins and losses in the chosen scope | `/strategies`, `/strategies/stats` |
| `/strategies/openers` | the openers tree: the first buildings in order, with games and record per level | `/query` |
| `/explore` | any dimensions and measures of the catalog, grouped and filtered, as a table or a heat map | `/catalog`, `/query` |

The URL holds every filter, step and setting, so every view is a link and the browser's back button works. The server reads the API; the browser never does. Dark and light themes follow the system and a switch. Keyboard: the race menus, the step editor and the timeline are walkable without a mouse.
