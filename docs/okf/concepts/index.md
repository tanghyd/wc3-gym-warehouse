# concepts

The rules the data follows and the pages that show it.

* [The pipeline](pipeline.md) - Bucket key, drain, ingest tables, dbt marts, API, page: what each stage owns and when it runs.
* [The drain](drain.md) - Lists a bucket prefix, detects change by ETag, size and parse version, parses each changed replay into one document, and never writes to the bucket.
* [Parse version](parse-version.md) - A constant stamped on every document and file row; a bump re-parses every replay on the next pass, and it is never lowered.
* [Races](races.md) - A player's race is the one he played; a Random pick keeps a flag, and the API speaks nine race values.
* [The winner rule](winner-rule.md) - A leave marked victory names the winner; else the first player to quit lost; else the saver quit first; a team game needs one whole team gone first; -1 otherwise.
* [Duplicates](duplicates.md) - A replay id hashes the game's facts, a game key groups the files of one game, and the most complete copy stands for it.
* [The mirror rule](mirror-rule.md) - A game both players fit counts once, from the lower player slot, and adds no win or loss.
* [Start locations and the tower rush](start-locations-and-tower-rush.md) - A player's start is read from where he builds, with three rules; a forward building stands under 3,000 map units from the opponent's start.
* [Search steps](search-steps.md) - What a side of a build-order search can say, step by step, and how a game matches.
* [The replay inspector](inspector.md) - The pages of the Next.js app, what each reads from the API, and the rule that the URL holds the view.
