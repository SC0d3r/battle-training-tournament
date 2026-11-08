import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  wilson,
  fitBT,
  pickSeeds,
  buildPlan,
  aggregate,
  renderHtml,
  loadControllerBot,
} from "../bt-tournament.mjs";
import { RULES_S2, RULES_URBAN, urbanFamilyFor } from "../arena-sim.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/* ------------------------------------------------------------------ */
/* Wilson interval                                                     */
/* ------------------------------------------------------------------ */

test("wilson matches the textbook interval for 7/10", () => {
  const [low, high] = wilson(7, 10);
  assert.ok(Math.abs(low - 0.3968) < 0.002, `low ${low}`);
  assert.ok(Math.abs(high - 0.8922) < 0.002, `high ${high}`);
});

test("wilson is the full range when there are no games", () => {
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

test("wilson stays inside [0, 1] at the edges", () => {
  const [low, high] = wilson(0, 10);
  assert.equal(low, 0);
  assert.ok(high > 0 && high < 0.35);
  const [low2, high2] = wilson(10, 10);
  assert.ok(high2 > 0.999);
  assert.ok(low2 > 0.65 && low2 < 1);
});

/* ------------------------------------------------------------------ */
/* Bradley-Terry / Elo                                                 */
/* ------------------------------------------------------------------ */

test("fitBT recovers the Elo gap of a 70/30 record", () => {
  const games = [];
  for (let i = 0; i < 70; i++) games.push({ a: 0, b: 1, winner: 0 });
  for (let i = 0; i < 30; i++) games.push({ a: 0, b: 1, winner: 1 });
  const elo = fitBT([0, 1], games);
  const gap = elo.get(0) - elo.get(1);
  // 400 * log10(70/30) = 147.2; the small prior moves it slightly.
  assert.ok(Math.abs(gap - 147.2) < 2, `gap ${gap}`);
});

test("fitBT ranks a better record higher", () => {
  const make = (wins, losses) => {
    const games = [];
    for (let i = 0; i < wins; i++) games.push({ a: 0, b: 1, winner: 0 });
    for (let i = 0; i < losses; i++) games.push({ a: 0, b: 1, winner: 1 });
    return fitBT([0, 1], games);
  };
  const strong = make(8, 2);
  const close = make(6, 4);
  const even = make(5, 5);
  assert.ok(strong.get(0) > close.get(0));
  assert.ok(close.get(0) > even.get(0));
  assert.ok(Math.abs(even.get(0) - 1500) < 0.01);
});

test("fitBT treats draws as half a win", () => {
  const games = [];
  for (let i = 0; i < 10; i++) games.push({ a: 0, b: 1, winner: null });
  const elo = fitBT([0, 1], games);
  assert.ok(Math.abs(elo.get(0) - 1500) < 1e-6);
  assert.ok(Math.abs(elo.get(1) - 1500) < 1e-6);
});

test("fitBT keeps undefeated and winless ratings finite", () => {
  const unbeaten = fitBT([0, 1], Array.from({ length: 10 }, () => ({ a: 0, b: 1, winner: 0 })));
  const winless = fitBT([0, 1], Array.from({ length: 10 }, () => ({ a: 0, b: 1, winner: 1 })));
  assert.ok(unbeaten.get(0) > 1500 && unbeaten.get(0) < 2200, `unbeaten ${unbeaten.get(0)}`);
  assert.ok(winless.get(0) < 1500 && winless.get(0) > 800, `winless ${winless.get(0)}`);
});

/* ------------------------------------------------------------------ */
/* Seeds and plan                                                      */
/* ------------------------------------------------------------------ */

test("pickSeeds is deterministic and follows the official formula", () => {
  const a = pickSeeds(5, RULES_S2);
  const b = pickSeeds(5, RULES_S2);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [1, 2, 3, 4, 5].map((s) => (s * 2654435761) >>> 0));
});

test("pickSeeds filters by urban terrain family", () => {
  const seeds = pickSeeds(4, RULES_URBAN, "city");
  assert.equal(seeds.length, 4);
  for (const seed of seeds) {
    assert.equal(urbanFamilyFor(seed, RULES_URBAN.urban.families), "city");
  }
});

test("pickSeeds refuses a family on a non-urban ruleset", () => {
  assert.throws(() => pickSeeds(2, RULES_S2, "city"), /urban/);
});

test("buildPlan mirrors every pairing on both sides", () => {
  const participants = [{ name: "a" }, { name: "b" }, { name: "c" }];
  const { jobs, seedList } = buildPlan(participants, 2, RULES_S2);
  assert.equal(seedList.length, 2);
  assert.equal(jobs.length, 3 * 2 * 2);
  for (const seed of seedList) {
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
      const forward = jobs.find((job) => job.seed === seed && job.a === i && job.b === j);
      const reverse = jobs.find((job) => job.seed === seed && job.a === j && job.b === i);
      assert.ok(forward, `missing ${i} vs ${j} on seed ${seed}`);
      assert.ok(reverse, `missing mirrored ${j} vs ${i} on seed ${seed}`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Controller isolation                                                */
/* ------------------------------------------------------------------ */

test("loadControllerBot runs a controller and counts tick errors", () => {
  const good = loadControllerBot(
    "globalThis.controller = { hello(h) { this.seen = h; }, tick(o) { return { tick: o.tick, units: [] }; } };",
    "good",
  );
  assert.equal(good.bot.tick({ tick: 7 }).tick, 7);
  assert.equal(good.stats.tickErrors, 0);

  const bad = loadControllerBot(
    "globalThis.controller = { tick() { throw new Error('boom'); } };",
    "bad",
  );
  const orders = bad.bot.tick({ tick: 3 });
  assert.deepEqual(orders, { tick: 3, units: [] });
  assert.equal(bad.stats.tickErrors, 1);
  assert.match(bad.stats.firstError, /boom/);
});

test("loadControllerBot isolates module-level state between instances", () => {
  const source = `
    globalThis.counter = (globalThis.counter || 0) + 1;
    globalThis.controller = { tick() { return { tick: 0, units: [], counter: globalThis.counter }; } };
  `;
  const first = loadControllerBot(source, "first");
  const second = loadControllerBot(source, "second");
  assert.equal(first.bot.tick({ tick: 0 }).counter, 1);
  assert.equal(second.bot.tick({ tick: 0 }).counter, 1);
});

test("loadControllerBot rejects a file that never sets controller", () => {
  assert.throws(() => loadControllerBot("const x = 1;", "empty"), /globalThis\.controller/);
});

/* ------------------------------------------------------------------ */
/* Aggregation and report                                              */
/* ------------------------------------------------------------------ */

function fakeResults(jobs) {
  const results = new Map();
  const zero = { dealtA: 0, takenA: 0, dealtB: 0, takenB: 0, refusedA: 0, refusedB: 0 };
  for (const job of jobs) {
    // side 0 always wins: job.a wins every game.
    results.set(job.id, {
      ok: true,
      winner: 0,
      reason: "objectives",
      ticks: 100,
      damage: { ...zero, dealtA: 12, takenA: 4, dealtB: 4, takenB: 12 },
      verified: job.id === 0 ? true : null,
      tickErrorsA: 0,
      tickErrorsB: 0,
      firstErrorA: null,
      firstErrorB: null,
    });
  }
  return results;
}

test("aggregate computes standings, matchups and verification counts", () => {
  const participants = [
    { name: "alpha", kind: "controller", version: "v1" },
    { name: "beta", kind: "controller", version: "v1" },
  ];
  const { jobs, seedList } = buildPlan(participants, 1, RULES_S2);
  const results = fakeResults(jobs);
  const report = aggregate({
    participants,
    jobs,
    results,
    rules: RULES_S2,
    config: { seeds: seedList.length, seedList, family: null, workers: 1, bootstrap: 20, maxTicks: null, command: "test" },
  });

  assert.equal(report.totals.planned, 2);
  assert.equal(report.totals.played, 2);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.verified, 1);

  const alpha = report.standings.find((row) => row.name === "alpha");
  const beta = report.standings.find((row) => row.name === "beta");
  assert.equal(alpha.games, 2);
  assert.equal(beta.games, 2);
  // side 0 wins both games, and the plan swaps sides, so the record is 1-1.
  assert.equal(alpha.wins, 1);
  assert.equal(alpha.losses, 1);
  assert.equal(alpha.score, 0.5);
  assert.ok(alpha.elo > 1400 && alpha.elo < 1600);
  // alpha deals 12 damage on its side-0 game and 4 on its side-1 game.
  assert.equal(alpha.damageDealt, 16);

  assert.equal(report.matchups.length, 1);
  assert.equal(report.matchups[0].games, 2);
  assert.equal(report.matchups[0].aWins, 1);
  assert.equal(report.matchups[0].bWins, 1);
  assert.equal(report.matchups[0].draws, 0);
});

test("aggregate records failed games instead of silently dropping them", () => {
  const participants = [
    { name: "alpha", kind: "controller", version: "v1" },
    { name: "beta", kind: "controller", version: "v1" },
  ];
  const { jobs } = buildPlan(participants, 1, RULES_S2);
  const results = fakeResults(jobs);
  results.set(jobs[0].id, { ok: false, error: "controller exploded" });
  const report = aggregate({
    participants,
    jobs,
    results,
    rules: RULES_S2,
    config: { seeds: 1, seedList: [jobs[0].seed], family: null, workers: 1, bootstrap: 10, maxTicks: null, command: "test" },
  });
  assert.equal(report.totals.failed, 1);
  assert.equal(report.totals.played, 1);
  assert.match(report.games.find((game) => game.job === jobs[0].id).error, /exploded/);
});

test("renderHtml is self-contained and renders every participant", () => {
  const participants = [
    { name: "alpha", kind: "controller", version: "v1" },
    { name: "house-random", kind: "house", version: "house-random" },
  ];
  const { jobs, seedList } = buildPlan(participants, 1, RULES_S2);
  const report = aggregate({
    participants,
    jobs,
    results: fakeResults(jobs),
    rules: RULES_S2,
    config: { seeds: 1, seedList, family: null, workers: 1, bootstrap: 10, maxTicks: null, command: "node bt-tournament.mjs test" },
  });
  const html = renderHtml(report);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /Leaderboard/);
  assert.match(html, /alpha/);
  assert.match(html, /house-random/);
  assert.doesNotMatch(html, /undefined/);
  assert.doesNotMatch(html, /<script/i, "report must not need scripts or external assets");
});

/* ------------------------------------------------------------------ */
/* End to end                                                          */
/* ------------------------------------------------------------------ */

test("CLI runs a two-game tournament and writes report.json + report.html", () => {
  const out = mkdtempSync(join(tmpdir(), "bt-tournament-"));
  try {
    execFileSync(
      process.execPath,
      [
        join(root, "bt-tournament.mjs"),
        "--controllers", join(root, "test", "fixtures", "noop.js"),
        "--vs", "random",
        "--seeds", "1",
        "--max-ticks", "60",
        "--workers", "1",
        "--out", out,
        "--quiet",
      ],
      { cwd: root, stdio: "pipe", timeout: 120000 },
    );
    assert.ok(existsSync(join(out, "report.json")));
    assert.ok(existsSync(join(out, "report.html")));
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    assert.equal(report.totals.planned, 2);
    assert.equal(report.totals.played, 2);
    assert.equal(report.standings.length, 2);
    assert.equal(report.meta.rules.version, RULES_S2.version);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
