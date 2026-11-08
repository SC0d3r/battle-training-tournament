# bt-tournament

A multi-controller tournament and tuning harness for [battle.training](https://battle.training), the tank-battle arena for AI coding agents.

`local-test.mjs` (the official harness) answers one question: *how does my controller do against the house bots?* This tool answers the next ones:

- How do several controllers rank against each other?
- How strong is each one, with an uncertainty interval instead of a single number?
- Which matchups are lopsided, and which are coin flips?
- Does a controller win on every map, or only on the seeds that suit it?

It runs the arena's own engine (`arena-sim.mjs`), so a local result is a result on the ladder: matches are deterministic, and every game can be re-simulated from its replay.

## Quick start

Requires Node.js 20 or newer. There are no npm dependencies.

```bash
# one controller against the four house bots, 4 seeds, both sides = 32 games
node bt-tournament.mjs --controllers examples/controller-starter.js \
  --vs brawler,holder,random,hunter --seeds 4

# two controllers and one house bot, round robin
node bt-tournament.mjs a.js b.js house-random --seeds 6

# tuning run: 20 seeds against the panel, with 8 sampled replays re-verified
node bt-tournament.mjs --controllers bot.js --vs brawler,holder,hunter,random \
  --seeds 20 --verify 8 --out tuning/
```

The run writes `report.json` (machine readable) and `report.html` (self-contained, no external assets) into `--out` (default `bt-report/`).

## What a run does

For every unordered pair of participants, the harness plays every seed **from both sides**. Mirroring removes map and side bias from the comparison: a bot cannot rank higher because it happened to spawn on the better half of the map.

Each match is run with a fresh controller instance in a fresh VM context, so module-level state cannot leak from one game into the next. Tick exceptions are counted per game, exactly as the ladder treats them (empty orders, match continues).

Work is spread over worker threads with a dynamic queue: workers pull small chunks, results stream back as games finish, and a worker that stops making progress is terminated and its unfinished games are retried on a replacement. A hung controller cannot stall the tournament.

## Output

`report.json` contains:

| field | meaning |
| --- | --- |
| `meta` | harness version, engine version, ruleset, seed list, command line |
| `participants` | id, name, kind (`controller` / `house`), controller version (sha256 prefix) |
| `totals` | planned, played, failed, draws, replays verified |
| `standings` | games, wins, losses, draws, score, Wilson interval, Elo, Elo bootstrap interval, damage, tick errors |
| `matchups` | per pairing: games, A wins, draws, B wins, A score with interval |
| `games` | one row per game: seed, sides, winner, reason, ticks, verification result |

`report.html` renders the same data: leaderboard with intervals, an Elo chart with error whiskers, a head-to-head matrix, and the matchup table.

## Method

- **Seeds** are deterministic: `seed = (s * 2654435761) mod 2^32`, the same rule the official local test uses. With `--rules urban --family city|bridge|nature`, only seeds of that terrain family are kept, so the maps stay the ladder's own seeds.
- **Score** is `(wins + 0.5 * draws) / games`, with a 95% Wilson score interval. Draws count as half a win, the standard Elo convention.
- **Elo** comes from a Bradley–Terry fit with the MM algorithm on the same scores, mapped to the conventional `1500 + 400 * log10(strength)` scale. A small prior (0.25 pseudo-wins and 0.5 pseudo-games) keeps undefeated and winless ratings finite; without it the maximum-likelihood estimate diverges. The interval is a bootstrap over games (300 resamples by default).
- **Verification** (`--verify N` or `--verify all`) re-simulates sampled replays and compares the per-tick hashes using the arena's own `verifyReplay()`.

## CLI

```
node bt-tournament.mjs [controllers...] [options]

  --controllers a.js,b.js   controller files (positional arguments also work)
  --vs brawler,holder       house bots to enter as participants (brawler, holder, random, hunter)
  --seeds N                 seeds per pairing per side (default 6)
  --workers N               parallel worker threads (default: up to 4)
  --rules s2|s1|sub|urban|<version>   ruleset (default s2 = public Armor ladder and cup)
  --family nature|city|bridge         urban only: play one terrain family
  --bootstrap N             bootstrap resamples for the Elo interval (default 300)
  --verify N|all            re-simulate and hash-check N sampled replays (default 0)
  --save-replays DIR        save up to --save-limit replays as JSONL
  --save-limit N            max replays to save (default 10)
  --max-ticks N             cap match length (mostly for tests)
  --timeout SECONDS         restart a worker that makes no progress for this long (default 120)
  --out DIR                 output directory (default bt-report)
  --no-html                 skip report.html
  --quiet                   only print the final tables
  --help                    usage
```

## Tuning workflow

1. Run the controller against the full house panel with enough seeds to make the interval useful (20 seeds = 40 games per opponent).
2. Read the matchup table: a low score against one style points at a specific weakness (for example `holder` punishing over-aggression, or `hunter` punishing a static squad).
3. Change one thing, re-run the same command. The seeds are identical, so the comparison is paired, not noisy.
4. Before uploading, run `--verify all` on a smaller seed count to prove the replays re-simulate cleanly.

## Limits worth knowing

- Node's JIT runs controller code roughly 15–20× faster than the ladder's QuickJS. Use the official `local-test.mjs --profile` for the per-tick budget; this harness measures strength, not timing.
- With `--max-ticks`, a truncated match counts as a draw. That is useful for fast tests, not for real rankings.
- Mirrored games are dependent: each seed is played twice with the sides swapped, so the two games share a map and are not independent samples. The bootstrap resamples individual games, which makes the Elo interval a little narrower than a strict cluster bootstrap by (pairing, seed) would. Treat overlapping intervals as "not clearly separated" rather than as a formal test.
- House bots are fixed at their usual seed (`seed: 7`) and are not tuned; they are a panel, not a ladder snapshot.
- The public ladder is the final judge. This tool tells you what to expect before you upload.

## Repository layout

```
bt-tournament.mjs          the harness (main thread + worker entry point)
arena-sim.mjs              official battle.training SDK, vendored for reproducibility
examples/controller-starter.js   official starter controller (demo participant)
examples/report.html       a real demo run, generated by the command in examples/README.md
examples/report.json       the same run as data
test/harness.test.mjs      unit + end-to-end tests (node --test)
```

`arena-sim.mjs` and `examples/controller-starter.js` are the official files served by `https://api.battle.training/sdk/` and `https://api.battle.training/starters/`. They are vendored unchanged so the repo runs offline; the arena remains the source of truth.

## Tests

```bash
node --test
```

The suite covers the Wilson interval, the Bradley–Terry fit (known Elo gaps, draws, undefeated players), seed and family selection, plan construction, aggregation, HTML rendering, controller isolation, and an end-to-end CLI run that writes a report.

## License

MIT for the harness. The vendored SDK and starter controller belong to battle.training.
