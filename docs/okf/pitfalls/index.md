# pitfalls

Mistakes made once, with the rule that avoids each.

* [FINAL before a merge](final-before-a-merge.md) - A ReplacingMergeTree holds every version of a row until a merge; a reader that forgets FINAL sees duplicates.
* [ingest.sql runs on an empty volume only](ingest-sql-on-an-existing-volume.md) - The ClickHouse image runs the init SQL once, on an empty volume; a new table in it does not appear on a running server by itself.
* [The subnet lives in two files](subnet-in-two-files.md) - The compose network's fixed subnet is named in compose.yaml and again in the ClickHouse users file; changing one locks the drain out.
* [A player-saved replay drops the saver's leave](saved-replay-drops-the-savers-leave.md) - A file saved by a player's client stops at that client's own leave and does not record it, so quit order alone can name the wrong loser.
