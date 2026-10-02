---
type: Domain Concept
title: Search steps
description: "What a side of a build-order search can say, step by step, and how a game matches."
resource: ../../../api/compile.py
tags: [api, web]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: compile
    resource: ../../../api/compile.py
    title: SearchStep, Group, Side and the compiler
---

A search has a Player side and an Opponent side. A side takes race values, a battle tag, the openers of an Openers row, and one to four groups of up to eight steps. A group holds when all its steps hold; the side matches when any group holds. Only the Player has an outcome, because the Opponent's is its reverse.

A step is at least `count` orders of any of `codes`, of one kind (`building`, `unit`, `upgrade`, `item`, `hero` or `skill`), each inside `from_s` to `to_s`; `exactly` makes the count exact.

- A skill count is a level: one point that takes the skill to `count` or more, counted since the hero's last retraining; `exactly` makes it the highest level.
- A repeat click (a tier hall, research, hero order or skill point within a second of the same one) is no order, and nor is a skill point past level 3.
- A hero step reads the order that trained the hero; `nth` makes it the side's 1st, 2nd or 3rd hero.
- A `then` step comes after the order that completes the step above, all its orders within `within_s` of it when set; each run of `then` steps is one match over the player's order times.
- A `before` step counts its orders before the order that completes step `before` of the group; with `negate` it holds when there is none.
- An `and` step is its own condition; `negate` makes it "did not happen".
- `forward` on a building step keeps the placements of [a tower rush](start-locations-and-tower-rush.md).

A result is a game: the Player side holds for one player and the Opponent side for the other. When they hold both ways round the game is [a mirror](mirror-rule.md). A preset in `api/strategies.yaml` is a named Player side; a variant holds its parent's steps, then its own.
