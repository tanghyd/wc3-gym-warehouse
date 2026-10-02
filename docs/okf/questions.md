---
type: Guide
title: Start here by question
description: "The questions a new contributor or an agent asks first, each with the concept that answers it; the list is also the benchmark the bundle is read against."
tags: [tooling]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
---

| Question | Read |
|---|---|
| How does a replay get from the bucket to a page? | [the pipeline](concepts/pipeline.md) |
| What does the drain do with a file it saw before? | [the drain](concepts/drain.md), [parse version](concepts/parse-version.md) |
| What is in ClickHouse before dbt runs? | [the ingest tables](data/ingest-tables.md) |
| Which games does the warehouse leave out? | [landing and staging](data/landing-and-staging.md) |
| Who won a game? | [the winner rule](concepts/winner-rule.md) |
| A game arrived as two files. Which one counts? | [duplicates](concepts/duplicates.md) |
| Why does a map show no wins and losses? | [the mirror rule](concepts/mirror-rule.md) |
| What is a player's race when he picked Random? | [races](concepts/races.md) |
| What is a tower rush, and where does a player start? | [start locations and the tower rush](concepts/start-locations-and-tower-rush.md) |
| What can a build-order search say? | [search steps](concepts/search-steps.md) |
| Which table answers the Replays page? | [player games](data/player-games.md) |
| Which table holds every order a player gave? | [the order marts](data/order-marts.md) |
| Where do object names and icons come from? | [seeds and objects](data/seeds-and-objects.md) |
| What does the API serve, and what stops a bad request? | [the API](api/overview.md) |
| What does each page of the inspector show? | [the inspector](concepts/inspector.md) |
| How do I run it on my machine? | [run locally](runbooks/run-locally.md) |
| How do I put it on a box? | [deploy the box](runbooks/deploy-box.md) |
| How do I write a test here? | [testing](conventions/testing.md) |
| Why dbt, why one box, why no backup? | [decisions](decisions/index.md) |
