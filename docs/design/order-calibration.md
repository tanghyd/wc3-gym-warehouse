# Order-count calibration against stat-events

Copied into the repo on 2026-09-11 from the job scratch that ran it. The Commands section records that one-off run; its paths no longer exist.

Data: 6 replay files from `gs://w3warehouse-05b6-replays/w3g/stat-events/`, copied 2026-09-11. All are v2.00 build 6117. The games were played before 2026-07-10 (the autumn leaves map is stamped `260706`). Every number below comes from `calib.out`, the output of `calib.sql` (see Commands).

## 1. What the sample is

| Recording | Game | Map | Players (w3grs id: name, race) | Length | Used |
|---|---|---|---|---|---|
| TESTCONTROL-NorthernIsles1 | CONTROL | TEST_CONTROL_NorthernIsles.w3x | 1 thanks#11187 N, 2 Solanum#21803 O | 6.9 min | yes |
| TESTLEAVEA-...G1Player1ReplayPlayer2Quit | G1 | TEST_LEAVE_A_NorthernIsles.w3x | 1 thanks#11187 N, 2 Solstice1221#11218 H | 5.5 min | yes |
| alternate-client/...G1Player2ReplayPlayer2Quit | G1 (2nd recording) | same | same | 5.1 min | check only |
| TESTLEAVEA-...G2Player2ReplayPlayer1Quit | G2 | TEST_LEAVE_A_NorthernIsles.w3x | 1 thanks#11187 N, 2 Solstice1221#11218 U | 7.0 min | yes |
| alternate-client/...G2Player1ReplayPlayer1Quit | G2 (2nd recording) | same | same | 6.5 min | check only |
| stat_events_test_2_autumn_leaves | AL | 1v1_AutumnLeaves_v2.0_STATEVENTS_...w3x | 1 thanks#11187 N vs Computer (Normal) H | 13.0 min | no, parser failure |

- 6 files are 4 games. The two G1 files have the same `replay_id`, and so do the two G2 files. Each is one game recorded by both clients.
- All are custom or LAN test games (game names "thanks", "thanks2", "Single Player"). None is a ladder game.
- The main table uses 3 games: CONTROL, G1 and G2, taking the longer recording of each.
- **AL is excluded.** In AL, w3grs gives 0 unit, 0 research, 0 tier and 0 hero orders. Stat-events gives 42, 12, 2 and 2 starts for the same player (Q9). w3grs also reports `buildtrain: 0`. This matches the "LAN post-2.0.2 detection" bug in `docs/plan-stat-events-pipeline.md`. Only buildings came through (20 orders vs 17 starts).

## 2. Decoder status

| Recording | `--force-202` | Without the flag | Events | Errors |
|---|---|---|---|---|
| CONTROL | same output | same output | 1276 | 0 |
| G1 main | same | same | 459 | 1: `Incomplete chunk set` at 331009 ms (recording ends at 331300 ms) |
| G1 alt | same | same | 445 | 0 |
| G2 main | same | same | 552 | 0 |
| G2 alt | same | same | 523 | 0 |
| AL | 1662 events | "no WC payloads" (rc=3) | 1662 | 0 |

- The Northern Isles files decode the same way with or without `--force-202`. AL needs the flag. The report uses the `--force-202` output for all 6.
- The G1 error is the known end-of-game race (the relay stops mid-chunk). It is 291 ms before the end and hits no build event.
- **Duplicate trap:** CONTROL has 2 senders, and each sender carries the full stream: 1247 event rows but only 624 distinct sequences. Without deduplication, every truth count in CONTROL doubles. I dedup on `(recording, sequence)`. G2 main has a sender handover (1..500, then 501..527) with no overlap. There are 0 missing sequences in all files.

## 3. How I matched

| Item | Method |
|---|---|
| Player | The stat-events `PlayerDetails.name` equals the w3grs `players[].name`. In all 5 used recordings, slot `s` maps to w3grs id `s+1` (Q1). |
| Code | `typeId`, `researchId`, `soldTypeId` and `itemTypeId` are 32-bit FourCC integers. `unhex(hex(toUInt32(id)))` gives the rawcode, which equals the w3grs order `id`. |
| Tier upgrade | `UpgradeStart` and `UpgradeCancel` carry the SOURCE hall (for example `etol`), while `UpgradeComplete` carries the TARGET (`etoa`). I map the source to the target with a static pair list: htow>hkee, hkee>hcas, ogre>ostr, ostr>ofrt, unpl>unp1, unp1>unp2, etol>etoa, etoa>etoe. Non-tier upgrades (uzig>uzg2) take the next `UpgradeComplete` at the same x,y. |
| Tavern hero | `UnitSold`, player = `buyerPlayer`. It counts as both start and complete. |
| Item | `HeroItemBought`. It counts as both start and complete. It covers hero purchases only. |
| Kind (orders) | hero = the w3grs `unknown` bucket with an upper-case code. tier = the 8 target codes in `buildings`. research = `upgrades`. building, unit and item use their own buckets. |
| Kind (truth) | Structure* = building. Upgrade* = tier if the target is in the list, else building. Research* = research. Unit* = hero if the code is upper-case, else unit. |
| Gap | The time since the previous same-code order by the same player, counted from the previous RAW order, not the previous kept one. |

Two facts that matter when you implement the rule:
- Hero-training orders are in w3grs `players[].unknown`, which is `mv__order_unknown` (kind `unknown`). They are not in `units`.
- Tier upgrades are in `buildings` (kind `building`). A rule for them must use the code list, not the kind.

## 4. Result: kind x rule, 3 games (Q2)

"Over" and "under" count objects (one object = recording, player and code) whose order count is above or below the truth. "Abs err" is the sum of |orders − truth|.

| Kind | Objects | Truth starts / completes | Rule | Orders | Over / under vs starts | Abs err vs starts | Over / under vs completes | Abs err vs completes |
|---|---|---|---|---|---|---|---|---|
| hero | 8 | 8 / 7 | raw | 14 | 3 / 0 | 6 | 4 / 0 | 7 |
| hero | | | **proposed** | 8 | **0 / 0** | **0** | 1 / 0 | 1 |
| hero | | | all<1000 | 8 | 0 / 0 | 0 | 1 / 0 | 1 |
| hero | | | all<250 | 8 | 0 / 0 | 0 | 1 / 0 | 1 |
| tier | 7 | 8 / 4 | all 4 rules | 8 | 0 / 0 | 0 | 3 / 0 | 4 |
| research | 2 | 2 / 2 | all 4 rules | 2 | 0 / 0 | 0 | 0 / 0 | 0 |
| building | 31 | 52 / 42 | raw = proposed | 58 | 6 / 0 | 6 | 9 / 0 | 16 |
| building | | | all<1000 | 55 | 4 / 1 | 5 | 9 / 0 | 13 |
| building | | | all<250 | 58 | 6 / 0 | 6 | 9 / 0 | 16 |
| unit | 13 | 86 / 85 | raw = proposed | 98 | 7 / 0 | 12 | 8 / 0 | 13 |
| unit | | | all<1000 | 85 | 2 / 3 | 7 | 2 / 3 | 6 |
| unit | | | all<250 | 87 | 3 / 2 | 7 | 3 / 2 | 6 |
| item | 4 | 3 / 3 | all 4 rules | 4 | 1 / 0 | 1 | 1 / 0 | 1 |

The alternate recordings give the same pattern (Q3): the hero error goes from 3 to 0 under every collapse rule, and the unit error goes from 7 to 4.

### Threshold sweep, collapse applied to every kind (Q5, abs err vs starts)

| Kind | 0 ms (raw) | 1 | 100 | 250 | 500 | 1000 | 2000 | 5000 |
|---|---|---|---|---|---|---|---|---|
| hero | 6 | 3 | 1 | 0 | 0 | 0 | 0 | 0 |
| building | 6 | 6 | 6 | 6 | 5 | 5 (1 under) | 5 (1 under) | 1 (1 under) |
| unit | 12 | 11 | 10 | 7 (2 under) | 7 (2 under) | 7 (3 under) | 8 (3 under) | 6 (4 under) |
| tier, research, item | no change at any threshold | | | | | | | |

### Gaps between same-code orders (Q6)

| Kind | Repeats | 0 ms | 1–249 ms | 250–999 ms | 1–5 s |
|---|---|---|---|---|---|
| hero | 6 | 3 | 3 | 0 | 0 |
| unit | 85 | 1 | 10 | 2 | 5 |
| building | 27 | 0 | 0 | 3 | 4 |
| tier | 1 | 0 | 0 | 0 | 0 (the one repeat is 128 s) |

## 5. The objects behind the errors (Q4, Q11, Q12)

| Game | Player | Code | Raw | Proposed | all<1000 | all<250 | Starts | Cancels | Completes | Cause |
|---|---|---|---|---|---|---|---|---|---|---|
| CONTROL | 1 N | Edem (hero) | 4 | 1 | 1 | 1 | 1 | 0 | 1 | clicks at 75113, 75193, 75193, 75193 |
| G1 | 1 N | Edem (hero) | 3 | 1 | 1 | 1 | 1 | 0 | 1 | 74188, 74251, 74251 |
| G2 | 2 U | Udea (hero) | 2 | 1 | 1 | 1 | 1 | 0 | 1 | 74157, 74346 |
| CONTROL | 2 O | ogru | 8 | 8 | 5 | 5 | 5 | 0 | 5 | 3 surplus clicks, all < 250 ms |
| G1 | 1 N | earc | 7 | 7 | 5 | 5 | 5 | 0 | 5 | 2 surplus clicks, all < 250 ms |
| G1 | 2 H | hpea | 11 | 11 | 9 | 9 | 11 | 0 | 10 | the collapse REMOVES 2 real starts |
| G2 | 2 U | ugho | 8 | 8 | 7 | 7 | 8 | 0 | 8 | the collapse REMOVES 1 real start |
| CONTROL, G1, G2 | 1 N | ewsp | 12 / 11 / 12 | same | 12 / 10 / 11 | 12 / 11 / 11 | 10 / 10 / 10 | 2 / 1 / 2 | 10 / 10 / 10 | surplus mostly > 1 s apart |
| CONTROL, G1, G2 | 1 N | eate | 2 | 2 | 2 | 2 | 1 | 0 | 1 | 2nd order 2.1–3.5 s later (re-placement) |
| CONTROL | 2 O | owtw | 6 | 6 | 5 | 6 | 5 | 3 | 0 | 3 cancels; no order rule can see them |
| G2 | 2 U | uzig | 5 | 5 | 5 | 5 | 4 | 0 | 4 | repeat 2.4 s later |
| G1 | 1 N | eaow | 2 | 2 | 1 | 2 | 1 | 0 | 0 | 402 ms repeat; the collapse is right |
| G2 | 1 N | eaoe | 2 | 2 | 1 | 2 | 2 | 0 | 0 | 877 ms repeat, 2 real starts; the collapse is wrong |
| G1 | 2 H | dust (item) | 1 | 1 | 1 | 1 | 0 | 0 | 0 | order with no `HeroItemBought` |

Unit collapse audit (Q12). I match at the count level, not order by order:

| Threshold | Orders collapsed | Match the surplus over starts | Remove real starts |
|---|---|---|---|
| 250 ms | 11 | 8 | 3 (hpea 2, ugho 1) |
| 1000 ms | 13 | 9 | 4 (hpea 2, ugho 1, hfoo 1) |

## 6. Timing of single-instance orders (Q7, Q8)

- The stat-events `game_time_s` has 1 s resolution. `payload_ms` is the arrival time. It lags `game_time_s` by 6 s at the median and by up to 18.7 s, so it is not a usable start time.
- The two clocks drift. Take each start second x1000 minus the nearest same-code order within ±3 s. The median of this difference moves from −346 ms (0–2 min, n=43) to −581 ms (2–4 min, n=23), then −971 ms (4–6 min, n=16), then −1327 ms (6+ min, n=1). The stat-events clock falls behind the replay clock by about 1 s over 6 minutes. I do not know the cause.
- All 17 first orders for single-instance objects in the 3 games are 113–1637 ms BEFORE `start_s x 1000`:

| Game | Code | First order (ms) | All orders (ms) | Start (s) | Start x 1000 − first order |
|---|---|---|---|---|---|
| CONTROL | Edem | 75113 | 75113, 75193 x3 | 75 | −113 |
| CONTROL | etoa | 160079 | 160079, 288546 | 159 | −1079 |
| CONTROL | Ofar | 64771 | 64771 | 64 | −771 |
| CONTROL | ostr | 150172 | 150172 | 150 | −172 |
| CONTROL | Nngs | 292125 | 292125 | 291 | −1125 |
| CONTROL | Robs | 303016 | 303016 | 302 | −1016 |
| CONTROL | Ropg | 337637 | 337637 | 336 | −1637 |
| G1 | Edem | 74188 | 74188, 74251 x2 | 74 | −188 |
| G1 | etoa | 161768 | 161768 | 161 | −768 |
| G1 | Hamg | 70655 | 70655 | 70 | −655 |
| G1 | hkee | 290672 | 290672 | 290 | −672 |
| G2 | Edem | 86979 | 86979 | 86 | −979 |
| G2 | etoa | 182646 | 182646 | 182 | −646 |
| G2 | Ekee | 340286 | 340286 | 339 | −1286 |
| G2 | Udea | 74157 | 74157, 74346 | 74 | −157 |
| G2 | unp1 | 244736 | 244736 | 244 | −736 |
| G2 | unp2 | 389327 | 389327 | 388 | −1327 |

- **Finding:** the first click and the logged start agree within the clock error (1 s floor plus up to 1.3 s of drift). The data shows no click-to-start delay. It cannot tell the first click of a burst from the last: the bursts span 63–189 ms, which is far below the resolution.
- **Use the first order time.** It is the earliest command, and in these games the extra clicks add at most 189 ms.
- The CONTROL etoa has 2 orders 128 s apart, and both are real starts (start, cancel at 284 s, start again at 288 s). A "keep the first only" rule would lose the second. The 1000 ms rule keeps it.

## 7. Recommendation

1. **Adopt the proposed rule.** For heroes, it removes all 6 extra orders (3 of 8 objects over-counted, then 0), and the alternate recordings confirm this. All hero repeats are below 190 ms, so 1000 ms has a wide margin.
2. **Tier and research: keep the rule. It is harmless but untested.** There were 0 sub-second repeats in 8 tier starts and 2 research starts. The only research-rich game (AL, 12 research starts) failed in w3grs.
3. **Buildings: keep raw.** No time rule gives a real improvement. The best is 500 ms (abs err 6 → 5, no under-count), which is one object. Most building surplus is 2–3.5 s re-placements (eate, uzig) and cancels (owtw, 3). Only stat-events can see those.
4. **Units: raw is the safe default. A 250 ms collapse is the only building or unit rule that clearly beats raw on net error** (12 → 7 of 86 starts). It removes 8 surplus clicks, but it also removes 3 real queued units. Raw errors are all over-counts, which makes raw an upper bound. The collapsed errors go both ways. Five orders in 13 objects is not enough evidence to change a one-sided error into a two-sided one.
5. **Completes need stat-events.** Against completes, raw buildings are off by 16 and tier by 4. The causes are cancels and work still in progress at game end, and no order rule can fix them.

## 8. Limits

- There are 3 usable games. All are short (5.5–7 min) custom test maps, and two are "leave" tests that end with a quit. The same player (thanks#11187, NE) is in all of them, against 2 opponents. The sample has no ladder games, no late game, and no high-APM spam.
- Small counts: 8 heroes, 8 tier starts, 2 research starts. The research result is not evidence.
- The stat-events tail is lost when a recording stops. For example, the G2 alternate recording has the unp2 order at 389327 ms but no start (Q10). The ~6 s payload lag means orders in the last seconds of a recording can have no truth.
- `UnitStarted` counts are taken as logged. I did not check whether a queued unit that is cancelled before its training begins emits `UnitStarted`.
- The gap is measured from the previous raw order, so a chain of clicks each < 1 s apart collapses fully. No chain in this data needs the other reading.

## Commands

```sh
C=/home/daniel/.claude/jobs/ac2bfdc7/tmp/cal
gcloud storage cp -r gs://w3warehouse-05b6-replays/w3g/stat-events/ $C/replays/
cd /home/daniel/code/warcraft/w3warehouse/pipeline/stat-events && npm install
# per replay n, once with --force-202 (se-f202) and once without (se-nof):
node src/extract.cjs <replay.w3g> [--force-202] > $C/se-<mode>/<n>/x.ndjson
node src/decode.cjs $C/se-<mode>/<n>/x.ndjson $C/se-<mode>/<n>
# w3grs:
cd $C/replays/stat-events
/home/daniel/code/warcraft/gym/wc3-gym-warehouse/pipeline/parse-rs/target/release/parse $C/w3grs/main *.w3g
/home/daniel/code/warcraft/gym/wc3-gym-warehouse/pipeline/parse-rs/target/release/parse $C/w3grs/alt alternate-client/*.w3g
# all tables Q1-Q13:
cd $C && /home/daniel/.claude/jobs/ac2bfdc7/tmp/ch/clickhouse local --queries-file calib.sql > calib.out
```

Separate probes that `clickhouse local` ran over `$C/se-f202/*/*.events.ndjson`: schema-name counts, hero `UnitStarted` rows, `PlayerDetails` per slot, `payload_ms − game_time_s x 1000` quantiles, senders and distinct sequences per recording, the Upgrade/Research/UnitSold/HeroItemBought row list, and the AL structure starts.
