---
type: Pitfall
title: A player-saved replay drops the saver's leave
description: "A file saved by a player's client stops at that client's own leave and does not record it, so quit order alone can name the wrong loser."
tags: [data]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: replays
    resource: ../../../dbt/models/marts/replays.sql
    title: The quitters list
---

# What happened

A replay a player saved held no leave for the saver, so the first recorded leave was the opponent's, and a rule that reads only recorded leaves named the saver the winner when the saver had quit first.

# The rule

[The winner rule](../concepts/winner-rule.md) appends the saver to the quit order, so with no player leave recorded the saver quit first. A victory leave still outranks quit order. The parser keeps every leave record and the saver's id so the rule can be written in SQL.
