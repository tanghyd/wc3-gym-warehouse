---
type: Domain Concept
title: The winner rule
description: "A leave marked victory names the winner; else the first player to quit lost; else the saver quit first; a team game needs one whole team gone first; -1 otherwise."
resource: ../../../dbt/models/marts/replays.sql
tags: [data]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: replays
    resource: ../../../dbt/models/marts/replays.sql
    title: The rule in SQL
  - id: test
    resource: ../../../dbt/tests/results_complement.sql
    title: The invariant
---

A replay holds no result, only leave records. `replays.winning_team_id` reads them, observers skipped:

1. A player leave marked victory names the winning team. The winner can leave the victory screen before the loser's leave is logged, so this outranks quit order.
2. Else, in a 1v1, the player opposite the first to quit won. The first to quit is the first player leave, or the saver when no player leave is recorded, because a file a client saved stops at its own leave and drops it.
3. Else, in a team game, the other team won when every player of one team left before any player of the other.
4. Else, and unless the game has exactly two teams, `-1`: no winner. `winner_names` is set exactly when a team won.

`player_games.result` is `win`, `loss` or `unknown` from the player's team against it. A game has one win and one loss, or two unknowns; a dbt test holds that.
