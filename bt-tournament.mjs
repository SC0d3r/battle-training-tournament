#!/usr/bin/env node
/**
 * bt-tournament.mjs — multi-controller tournament and tuning harness for battle.training.
 *
 * The official `local-test.mjs` answers one question: "how does MY controller do against the
 * house bots?" This harness answers the next ones:
 *
 *   - how do several controllers rank against each other (round robin, mirrored sides)?
 *   - how strong is each one, with an uncertainty interval instead of a single number?
 *   - which matchups are lopsided, and which are coin flips?
 *   - does the controller behave the same on every seed, or does it win on some maps only?
 *
 * It runs the arena's own engine (arena-sim.mjs), so a result here is a result on the ladder.
 * Every game is deterministic: a seed plus a controller version always produces the same match.
 *
 * Usage:
 *   node bt-tournament.mjs --controllers a.js,b.js --vs brawler,holder --seeds 8
 *   node bt-tournament.mjs a.js b.js house-random --seeds 4 --workers 4 --out report/
 *   node bt-tournament.mjs --controllers bot.js --vs brawler,holder,hunter,random --seeds 20
 *   node bt-tournament.mjs --controllers a.js,b.js --seeds 6 --verify 8 --save-replays replays/
 *
 * Output: report.json (machine readable) and report.html (self-contained, no external assets).
 *
 * Method (also printed in the report):
 *   - every unordered pair plays every seed from both sides, so map and side bias cancel out;
 *   - score = (wins + 0.5 * draws) / games, with a 95% Wilson interval;
 *   - Elo comes from a Bradley-Terry fit (MM algorithm) on the same scores, mapped to the
 *     conventional 1500 + 400*log10(strength) scale, with a 95% bootstrap interval over games;
 *   - a small prior (0.25 pseudo-wins, 0.5 pseudo-games) keeps undefeated and winless ratings
 *     finite instead of diverging to +/-infinity;
 *   - a sample of replays is re-simulated and hash-checked with the arena's own verifyReplay().
 *
 * The file is also the worker entry point. `isMainThread` decides which half runs, so the
 * worker can be spawned with `new Worker(new URL(import.meta.url))`.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { createContext, runInContext } from "node:vm";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  runMatch,
  makeHouseBot,
  encodeReplay,
  decodeReplay,
  verifyReplay,
  rulesFor,
  RULES_S1,
  RULES_S2,
  RULES_SUB,
  RULES_URBAN,
  RULESETS,
  urbanFamilyFor,
  ENGINE_VERSION,
} from "./arena-sim.mjs";

export const HARNESS_VERSION = "1.0.0";
export const HOUSE_STYLES = ["brawler", "holder", "random", "hunter"];

const RULE_ALIASES = {
  s1: RULES_S1,
  s2: RULES_S2,
  armor: RULES_S2,
  sub: RULES_SUB,
  "silent-service": RULES_SUB,
  urban: RULES_URBAN,
  "armor-preview": RULES_URBAN,
};

// Bradley-Terry prior: half a draw against an average opponent. Without it the MLE diverges
// for a participant that never lost (or never won) in a small tournament.
const PRIOR_WINS = 0.25;
const PRIOR_GAMES = 0.5;

const USAGE = `bt-tournament ${HARNESS_VERSION} — multi-controller tournament for battle.training

usage: node bt-tournament.mjs [controllers...] [options]

  --controllers a.js,b.js   controller files (positional arguments also work)
  --vs brawler,holder       house bots to enter as participants (${HOUSE_STYLES.join(", ")})
  --seeds N                 seeds per pairing per side (default 6)
  --workers N               parallel worker threads (default ${Math.min(4, Math.max(1, cpus().length - 1))})
  --rules s2|s1|sub|urban|<version>   ruleset (default s2 = public Armor ladder + cup)
  --family nature|city|bridge         urban only: play one terrain family
  --bootstrap N             bootstrap resamples for the Elo interval (default 300)
  --verify N|all            re-simulate and hash-check N sampled replays (default 0)
  --save-replays DIR        save up to --save-limit replays as JSONL
  --save-limit N            max replays to save (default 10)
  --max-ticks N             cap match length (mostly for tests)
  --timeout SECONDS         kill a worker that makes no progress for this long (default 120)
  --out DIR                 output directory (default bt-report)
  --no-html                 skip report.html
  --quiet                   only print the final tables
  --help                    this text

examples:
  node bt-tournament.mjs --controllers bot.js --vs brawler,holder,hunter,random --seeds 20
  node bt-tournament.mjs a.js b.js house-random --seeds 4 --verify 4 --out report/`;

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export function parseArgs(argv) {
  const opt = {
    controllers: [],
    vs: [],
    seeds: 6,
    workers: Math.min(4, Math.max(1, cpus().length - 1)),
    rules: "s2",
    family: null,
    bootstrap: 300,
    verify: 0,
    saveReplays: null,
    saveLimit: 10,
    maxTicks: null,
    timeout: 120,
    out: "bt-report",
    html: true,
    quiet: false,
    help: false,
  };
  const valueFlags = new Set([
    "controllers", "vs", "seeds", "workers", "rules", "family", "bootstrap",
    "verify", "save-replays", "save-limit", "max-ticks", "timeout", "out",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { opt.help = true; continue; }
    if (arg === "--quiet") { opt.quiet = true; continue; }
    if (arg === "--no-html") { opt.html = false; continue; }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      if (!valueFlags.has(key)) throw new Error(`unknown flag --${key} (try --help)`);
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new Error(`--${key} needs a value`);
      switch (key) {
        case "controllers": opt.controllers.push(...splitList(value)); break;
        case "vs": opt.vs.push(...splitList(value)); break;
        case "seeds": opt.seeds = positiveInt(value, "--seeds"); break;
        case "workers": opt.workers = positiveInt(value, "--workers"); break;
        case "rules": opt.rules = value; break;
        case "family": opt.family = value; break;
        case "bootstrap": opt.bootstrap = positiveInt(value, "--bootstrap"); break;
        case "verify": opt.verify = value === "all" ? "all" : nonNegativeInt(value, "--verify"); break;
        case "save-replays": opt.saveReplays = value; break;
        case "save-limit": opt.saveLimit = positiveInt(value, "--save-limit"); break;
        case "max-ticks": opt.maxTicks = positiveInt(value, "--max-ticks"); break;
        case "timeout": opt.timeout = positiveInt(value, "--timeout"); break;
        case "out": opt.out = value; break;
      }
      continue;
    }
    opt.controllers.push(arg);
  }
  return opt;
}

function splitList(value) {
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}

function positiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}

function nonNegativeInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
  return n;
}

export function resolveRules(name) {
  const key = String(name);
  const rules = RULE_ALIASES[key.toLowerCase()] ?? RULESETS[key] ?? null;
  if (!rules) {
    throw new Error(`unknown rules "${name}"; use s1, s2, sub, urban, or a version from: ${Object.keys(RULESETS).join(", ")}`);
  }
  return rules;
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

/**
 * Deterministic seed list. Mirrors local-test.mjs: seed_s = (s * 2654435761) mod 2^32.
 * With --family, only seeds whose urban terrain family matches are kept, so the maps stay
 * the ladder's own seeds instead of being forced.
 */
export function pickSeeds(count, rules, family = null) {
  const seeds = [];
  for (let s = 1; seeds.length < count && s < count * 50; s++) {
    const seed = (s * 2654435761) >>> 0;
    if (family) {
      if (!rules.urban) throw new Error("--family needs --rules urban");
      if (urbanFamilyFor(seed, rules.urban.families) !== family) continue;
    }
    seeds.push(seed);
  }
  if (seeds.length < count) {
    throw new Error(`only found ${seeds.length}/${count} seeds for family "${family}"`);
  }
  return seeds;
}

/**
 * Round robin: every unordered pair, every seed, both sides.
 * `a` is the participant on side 0, `b` on side 1. The mirrored job covers the other side.
 */
export function buildPlan(participants, seeds, rules, family = null) {
  const seedList = pickSeeds(seeds, rules, family);
  const jobs = [];
  let id = 0;
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      for (const seed of seedList) {
        jobs.push({ id: id++, seed, a: i, b: j });
        jobs.push({ id: id++, seed, a: j, b: i });
      }
    }
  }
  return { jobs, seedList };
}

/* ------------------------------------------------------------------ */
/* Controller loading (also used by the worker)                        */
/* ------------------------------------------------------------------ */

/**
 * Evaluate a controller file in a fresh VM context, exactly once per match, so module-level
 * state cannot leak from one game into the next. Returns the bot plus per-game error counters.
 */
export function loadControllerBot(source, name) {
  const sandbox = { console, performance };
  createContext(sandbox);
  try {
    runInContext(source, sandbox, { filename: `${name}.js`, timeout: 10000 });
  } catch (error) {
    throw new Error(`controller ${name} failed to load: ${error?.message ?? error}`);
  }
  const c = sandbox.controller;
  if (!c || typeof c.tick !== "function") {
    throw new Error(`controller ${name} must set globalThis.controller = { hello(h), tick(o) }`);
  }
  const stats = { tickErrors: 0, firstError: null };
  const bot = {
    hello(h) {
      if (typeof c.hello === "function") c.hello(h);
    },
    tick(observation) {
      try {
        return c.tick(observation);
      } catch (error) {
        stats.tickErrors++;
        if (!stats.firstError) stats.firstError = String(error?.message ?? error);
        // Same behaviour as the ladder: a throwing tick sends no orders and the match goes on.
        return { tick: observation.tick, units: [] };
      }
    },
  };
  if (typeof c.draft === "function") bot.draft = (h) => c.draft(h);
  return { bot, stats };
}

function makeBot(participant) {
  if (participant.kind === "house") {
    return {
      bot: makeHouseBot({ style: participant.style, seed: 7 }),
      stats: { tickErrors: 0, firstError: null },
    };
  }
  return loadControllerBot(participant.source, participant.name);
}

/* ------------------------------------------------------------------ */
/* Worker                                                              */
/* ------------------------------------------------------------------ */

function workerMain() {
  const cfg = workerData;
  const rules = resolveRules(cfg.rules);
  const verifySet = new Set(cfg.verifyIds);
  const saveSet = new Set(cfg.saveIds);
  const participants = cfg.participants;

  const runJob = (job) => {
    const A = makeBot(participants[job.a]);
    const B = makeBot(participants[job.b]);
    const damage = { dealtA: 0, takenA: 0, dealtB: 0, takenB: 0, refusedA: 0, refusedB: 0 };

    const onTick = (state, events) => {
      if (!events || events.length === 0) return;
      let sides = null;
      const sideOf = (unitId) => {
        if (!sides) sides = new Map(state.units.map((u) => [u.id, u.side]));
        return sides.get(unitId);
      };
      for (const event of events) {
        if (event.kind === "hit") {
          const victimSide = sideOf(event.unit);
          if (victimSide === 0) damage.takenA += event.damage;
          else if (victimSide === 1) damage.dealtA += event.damage;
        } else if (event.kind === "splash") {
          for (const victim of event.victims ?? []) {
            const victimSide = sideOf(victim.unit);
            if (victimSide === 0) damage.takenA += victim.damage;
            else if (victimSide === 1) damage.dealtA += victim.damage;
          }
        } else if (event.kind === "refused") {
          if (event.side === 0) damage.refusedA++;
          else if (event.side === 1) damage.refusedB++;
        }
      }
    };

    let match;
    try {
      match = runMatch(job.seed, A.bot, B.bot, {
        rules,
        maxTicks: cfg.maxTicks ?? undefined,
        names: [participants[job.a].name, participants[job.b].name],
        versions: [participants[job.a].version, participants[job.b].version],
        onTick,
      });
    } catch (error) {
      return { ok: false, error: String(error?.stack ?? error), job };
    }

    // Damage dealt by B is damage taken by A, and the other way round.
    damage.dealtB = damage.takenA;
    damage.takenB = damage.dealtA;

    let replayText = null;
    let verified = null;
    if (verifySet.has(job.id) || saveSet.has(job.id)) {
      try {
        replayText = encodeReplay(match.replay);
      } catch (error) {
        verified = { ok: false, reason: `encode failed: ${error?.message ?? error}` };
      }
    }
    if (verifySet.has(job.id) && replayText) {
      try {
        const replay = decodeReplay(replayText);
        const check = verifyReplay(replay, { rules: rulesFor(replay.header.rulesVersion) });
        verified = check.ok ? true : { ok: false, reason: check.reason, tick: check.firstMismatch };
      } catch (error) {
        verified = { ok: false, reason: String(error?.message ?? error) };
      }
    }
    if (saveSet.has(job.id) && replayText) {
      const fileName = `game-${String(job.id).padStart(4, "0")}-${slug(participants[job.a].name)}-vs-${slug(participants[job.b].name)}-seed${job.seed}.jsonl`;
      try {
        writeFileSync(join(cfg.saveDir, fileName), replayText);
      } catch {
        /* a failed replay write must not fail the game */
      }
    }

    return {
      ok: true,
      winner: match.final.winner,
      reason: match.final.reason ?? null,
      ticks: match.final.tick,
      damage,
      verified,
      tickErrorsA: A.stats.tickErrors,
      tickErrorsB: B.stats.tickErrors,
      firstErrorA: A.stats.firstError,
      firstErrorB: B.stats.firstError,
    };
  };

  parentPort.on("message", (message) => {
    if (message.type === "stop") {
      parentPort.close();
      return;
    }
    if (message.type !== "chunk") return;
    for (const job of message.jobs) {
      let result;
      try {
        result = runJob(job);
      } catch (error) {
        result = { ok: false, error: String(error?.stack ?? error), job };
      }
      parentPort.postMessage({ type: "game", jobId: job.id, result });
    }
    parentPort.postMessage({ type: "chunk-done", chunkId: message.chunkId });
    parentPort.postMessage({ type: "ready" });
  });
  parentPort.postMessage({ type: "ready" });
}

/* ------------------------------------------------------------------ */
/* Parallel runner                                                     */
/* ------------------------------------------------------------------ */

/**
 * Dynamic work queue: workers pull small chunks, so a slow or hung controller cannot stall the
 * whole tournament. A worker that stops reporting progress is terminated and its unfinished
 * games are retried (up to MAX_ATTEMPTS) on a replacement worker.
 */
function runWorkers({ participants, jobs, opt, verifyIds, saveIds, saveDir }) {
  const MAX_ATTEMPTS = 3;
  return new Promise((resolvePromise, reject) => {
    const results = new Map();
    const attempts = new Map();
    const queue = jobs.slice();
    const total = jobs.length;
    const chunkSize = Math.max(1, Math.min(8, Math.ceil(total / Math.max(1, opt.workers * 8))));
    let chunkCounter = 0;
    let finished = false;
    let lastProgressAt = 0;
    const workers = [];

    const payload = {
      participants: participants.map((p) => ({
        name: p.name,
        kind: p.kind,
        source: p.source ?? null,
        style: p.style ?? null,
        version: p.version,
      })),
      rules: opt.rules,
      maxTicks: opt.maxTicks,
      verifyIds,
      saveIds,
      saveDir,
    };

    const progress = () => {
      if (opt.quiet) return;
      const done = results.size;
      const now = Date.now();
      if (now - lastProgressAt < 150 && done !== total) return;
      lastProgressAt = now;
      process.stderr.write(`\r  ${done}/${total} games (${((100 * done) / total).toFixed(1)}%)`);
      if (done === total) process.stderr.write("\n");
    };

    let firstGameTimer = null;
    const finishIfDone = () => {
      if (finished || results.size < total) return;
      finished = true;
      clearInterval(watchdog);
      if (firstGameTimer) clearTimeout(firstGameTimer);
      for (const w of workers) {
        try { w.worker.postMessage({ type: "stop" }); } catch { /* already gone */ }
      }
      setTimeout(() => {
        for (const w of workers) w.worker.terminate().catch(() => {});
        resolvePromise(results);
      }, 250);
    };

    const sendChunk = (w) => {
      if (w.dead) return;
      if (queue.length === 0) {
        w.busy = false;
        w.worker.postMessage({ type: "stop" });
        return;
      }
      const chunk = queue.splice(0, chunkSize);
      w.busy = true;
      w.current = chunk;
      w.lastMessageAt = Date.now();
      w.worker.postMessage({ type: "chunk", chunkId: chunkCounter++, jobs: chunk });
    };

    const spawn = () => {
      const w = {
        worker: null,
        busy: false,
        current: [],
        lastMessageAt: Date.now(),
        dead: false,
      };
      w.worker = new Worker(new URL(import.meta.url), { workerData: payload });
      w.worker.on("message", (message) => {
        w.lastMessageAt = Date.now();
        if (message.type === "ready") {
          if (!w.busy) sendChunk(w);
        } else if (message.type === "game") {
          if (!results.has(message.jobId)) {
            results.set(message.jobId, message.result);
            progress();
            finishIfDone();
          }
        } else if (message.type === "chunk-done") {
          w.busy = false;
          sendChunk(w);
        }
      });
      w.worker.on("error", (error) => {
        if (!opt.quiet) process.stderr.write(`\n  worker error: ${error?.message ?? error}\n`);
      });
      w.worker.on("exit", () => {
        w.dead = true;
        const index = workers.indexOf(w);
        if (index >= 0) workers.splice(index, 1);
        if (finished) return;
        // Requeue whatever this worker did not finish, then replace it if there is work left.
        for (const job of w.current) {
          if (results.has(job.id)) continue;
          const tries = (attempts.get(job.id) ?? 0) + 1;
          attempts.set(job.id, tries);
          if (tries > MAX_ATTEMPTS) {
            results.set(job.id, { ok: false, error: `worker died ${tries} times on this game` });
            progress();
          } else {
            queue.push(job);
          }
        }
        finishIfDone();
        if (!finished && queue.length > 0) spawn();
      });
      workers.push(w);
      return w;
    };

    const watchdog = setInterval(() => {
      const now = Date.now();
      for (const w of workers) {
        if (w.dead || !w.busy) continue;
        if (now - w.lastMessageAt > opt.timeout * 1000) {
          if (!opt.quiet) {
            process.stderr.write(`\n  worker made no progress for ${opt.timeout}s — restarting it\n`);
          }
          w.worker.terminate().catch(() => {});
        }
      }
    }, Math.min(5000, Math.max(1000, (opt.timeout * 1000) / 4)));

    for (let i = 0; i < Math.min(opt.workers, total); i++) spawn();
    if (total === 0) { finished = true; clearInterval(watchdog); resolvePromise(results); }
    firstGameTimer = setTimeout(() => {
      if (!finished && results.size === 0) {
        clearInterval(watchdog);
        finished = true;
        reject(new Error("no game finished within the first timeout window — check the controller files"));
      }
    }, Math.min(60000, opt.timeout * 1000));
    firstGameTimer.unref?.();
  });
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

/** 95% Wilson score interval for a binomial proportion. */
export function wilson(successes, n, z = 1.959963984540054) {
  if (!n) return [0, 1];
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [
    Math.max(0, (centre - margin) / denominator),
    Math.min(1, (centre + margin) / denominator),
  ];
}

/**
 * Bradley-Terry fit with the MM algorithm, mapped to Elo.
 * `games` rows: { a, b, winner } where winner is 0 (a), 1 (b) or null (draw).
 * Draws count as half a win for each side, the standard Elo score convention.
 */
export function fitBT(participantIds, games, iterations = 400) {
  const strength = new Map(participantIds.map((id) => [id, 1]));
  for (let iteration = 0; iteration < iterations; iteration++) {
    const wins = new Map(participantIds.map((id) => [id, PRIOR_WINS]));
    const denominator = new Map(participantIds.map((id) => [id, PRIOR_GAMES]));
    for (const game of games) {
      if (game.winner === 0) wins.set(game.a, wins.get(game.a) + 1);
      else if (game.winner === 1) wins.set(game.b, wins.get(game.b) + 1);
      else {
        wins.set(game.a, wins.get(game.a) + 0.5);
        wins.set(game.b, wins.get(game.b) + 0.5);
      }
      const sum = strength.get(game.a) + strength.get(game.b);
      denominator.set(game.a, denominator.get(game.a) + 1 / sum);
      denominator.set(game.b, denominator.get(game.b) + 1 / sum);
    }
    let logSum = 0;
    for (const id of participantIds) {
      const value = wins.get(id) / denominator.get(id);
      strength.set(id, Math.max(value, 1e-12));
      logSum += Math.log(strength.get(id));
    }
    const geometricMean = Math.exp(logSum / participantIds.length);
    for (const id of participantIds) strength.set(id, strength.get(id) / geometricMean);
  }
  const elo = new Map();
  for (const id of participantIds) elo.set(id, 1500 + 400 * Math.log10(strength.get(id)));
  return elo;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index];
}

function eloWithBootstrap(participantIds, games, resamples) {
  const elo = fitBT(participantIds, games);
  const samples = new Map(participantIds.map((id) => [id, []]));
  if (resamples > 0 && games.length > 1) {
    for (let i = 0; i < resamples; i++) {
      const draw = new Array(games.length);
      for (let g = 0; g < games.length; g++) {
        draw[g] = games[(Math.random() * games.length) | 0];
      }
      const fit = fitBT(participantIds, draw);
      for (const id of participantIds) samples.get(id).push(fit.get(id));
    }
  }
  const result = new Map();
  for (const id of participantIds) {
    const values = samples.get(id).sort((x, y) => x - y);
    result.set(id, {
      elo: elo.get(id),
      ci: values.length ? [percentile(values, 0.025), percentile(values, 0.975)] : null,
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

export function aggregate({ participants, jobs, results, rules, config }) {
  const standings = participants.map((p, id) => ({
    id,
    name: p.name,
    kind: p.kind,
    version: p.version,
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    damageDealt: 0,
    damageTaken: 0,
    refused: 0,
    tickErrors: 0,
    firstError: null,
  }));

  const matchups = new Map();
  const games = [];
  let failed = 0;
  let verified = 0;
  let verifyFailed = 0;
  let draws = 0;

  for (const job of jobs) {
    const result = results.get(job.id);
    if (!result || !result.ok) {
      failed++;
      games.push({
        job: job.id,
        seed: job.seed,
        a: job.a,
        b: job.b,
        error: result ? result.error : "missing result",
      });
      continue;
    }
    const A = standings[job.a];
    const B = standings[job.b];
    A.games++;
    B.games++;
    if (result.winner === 0) { A.wins++; B.losses++; }
    else if (result.winner === 1) { B.wins++; A.losses++; }
    else { A.draws++; B.draws++; draws++; }

    A.damageDealt += result.damage.dealtA;
    A.damageTaken += result.damage.takenA;
    B.damageDealt += result.damage.dealtB;
    B.damageTaken += result.damage.takenB;
    A.refused += result.damage.refusedA;
    B.refused += result.damage.refusedB;
    A.tickErrors += result.tickErrorsA;
    B.tickErrors += result.tickErrorsB;
    if (!A.firstError && result.firstErrorA) A.firstError = result.firstErrorA;
    if (!B.firstError && result.firstErrorB) B.firstError = result.firstErrorB;

    const low = Math.min(job.a, job.b);
    const high = Math.max(job.a, job.b);
    const key = `${low}:${high}`;
    let matchup = matchups.get(key);
    if (!matchup) {
      matchup = { a: low, b: high, games: 0, aWins: 0, draws: 0, bWins: 0 };
      matchups.set(key, matchup);
    }
    matchup.games++;
    if (result.winner === 0) {
      if (job.a === low) matchup.aWins++;
      else matchup.bWins++;
    } else if (result.winner === 1) {
      if (job.b === low) matchup.aWins++;
      else matchup.bWins++;
    } else {
      matchup.draws++;
    }

    if (result.verified === true) verified++;
    else if (result.verified && result.verified.ok === false) verifyFailed++;

    games.push({
      job: job.id,
      seed: job.seed,
      a: job.a,
      b: job.b,
      winner: result.winner,
      reason: result.reason,
      ticks: result.ticks,
      verified: result.verified,
    });
  }

  // Score and Wilson interval per participant.
  for (const row of standings) {
    const score = row.games ? (row.wins + 0.5 * row.draws) / row.games : 0;
    row.score = score;
    row.scoreCI = wilson(row.wins + 0.5 * row.draws, row.games);
  }

  // Elo only among participants that actually played.
  const activeIds = standings.filter((row) => row.games > 0).map((row) => row.id);
  const playedGames = games.filter((game) => !game.error);
  if (activeIds.length >= 2) {
    const elo = eloWithBootstrap(activeIds, playedGames, config.bootstrap);
    for (const row of standings) {
      const entry = elo.get(row.id);
      row.elo = entry ? entry.elo : null;
      row.eloCI = entry ? entry.ci : null;
    }
  } else {
    for (const row of standings) { row.elo = null; row.eloCI = null; }
  }

  const matchupRows = [...matchups.values()].map((m) => {
    const aScore = m.games ? (m.aWins + 0.5 * m.draws) / m.games : 0;
    return {
      ...m,
      aName: standings[m.a].name,
      bName: standings[m.b].name,
      aScore,
      aScoreCI: wilson(m.aWins + 0.5 * m.draws, m.games),
    };
  });

  return {
    meta: {
      harness: `bt-tournament ${HARNESS_VERSION}`,
      generatedAt: new Date().toISOString(),
      engine: ENGINE_VERSION,
      rules: { version: rules.version, hash: rulesHashSafe(rules) },
      command: config.command,
      config: {
        seeds: config.seeds,
        seedList: config.seedList,
        family: config.family,
        workers: config.workers,
        bootstrap: config.bootstrap,
        maxTicks: config.maxTicks,
      },
    },
    participants: standings.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      version: row.version,
    })),
    totals: {
      planned: jobs.length,
      played: jobs.length - failed,
      failed,
      draws,
      verified,
      verifyFailed,
    },
    standings,
    matchups: matchupRows,
    games,
  };
}

function rulesHashSafe(rules) {
  try {
    // Keep the report readable: the full rules object is large and changes rarely.
    return createHash("sha256").update(JSON.stringify(rules)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* HTML report                                                         */
/* ------------------------------------------------------------------ */

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[ch]));

const pct = (value) => `${(100 * value).toFixed(1)}%`;
const num = (value, digits = 1) => (value == null ? "—" : value.toFixed(digits));

function eloCell(row) {
  if (row.elo == null) return '<span class="muted">—</span>';
  const interval = row.eloCI
    ? ` <span class="muted">[${Math.round(row.eloCI[0])}, ${Math.round(row.eloCI[1])}]</span>`
    : "";
  return `<b>${Math.round(row.elo)}</b>${interval}`;
}

function eloChart(ranked) {
  const rows = ranked.filter((row) => row.elo != null);
  if (rows.length === 0) return '<p class="muted">No Elo ratings: not enough games.</p>';
  const lows = rows.map((row) => (row.eloCI ? row.eloCI[0] : row.elo));
  const highs = rows.map((row) => (row.eloCI ? row.eloCI[1] : row.elo));
  const min = Math.min(...lows) - 15;
  const max = Math.max(...highs) + 15;
  const width = 860;
  const left = 190;
  const right = 70;
  const rowHeight = 34;
  const height = rows.length * rowHeight + 34;
  const x = (value) => left + ((value - min) / Math.max(1, max - min)) * (width - left - right);
  const mid = 1500 >= min && 1500 <= max ? 1500 : null;
  const parts = [];
  parts.push(`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Elo ratings with 95% intervals" class="chart">`);
  if (mid != null) {
    parts.push(`<line x1="${x(mid)}" y1="10" x2="${x(mid)}" y2="${height - 10}" class="baseline"/>`);
    parts.push(`<text x="${x(mid)}" y="${height - 1}" text-anchor="middle" class="axis">1500</text>`);
  }
  rows.forEach((row, index) => {
    const y = 22 + index * rowHeight;
    const value = x(row.elo);
    const low = x(row.eloCI ? row.eloCI[0] : row.elo);
    const high = x(row.eloCI ? row.eloCI[1] : row.elo);
    const colour = row.kind === "house" ? "#5b8def" : "#e4572e";
    parts.push(`<text x="${left - 12}" y="${y + 5}" text-anchor="end" class="name">${escapeHtml(row.name)}</text>`);
    parts.push(`<rect x="${left}" y="${y - 7}" width="${width - left - right}" height="14" rx="3" class="track"/>`);
    parts.push(`<rect x="${Math.min(low, value)}" y="${y - 5}" width="${Math.max(2, Math.abs(value - low))}" height="10" rx="3" fill="${colour}"/>`);
    parts.push(`<line x1="${low}" y1="${y}" x2="${high}" y2="${y}" class="whisker"/>`);
    parts.push(`<line x1="${low}" y1="${y - 5}" x2="${low}" y2="${y + 5}" class="whisker"/>`);
    parts.push(`<line x1="${high}" y1="${y - 5}" x2="${high}" y2="${y + 5}" class="whisker"/>`);
    parts.push(`<text x="${width - right + 10}" y="${y + 5}" class="value">${Math.round(row.elo)}</text>`);
  });
  parts.push("</svg>");
  return parts.join("\n");
}

function headToHead(standings, matchups) {
  const index = new Map(standings.map((row) => [row.id, row]));
  const byPair = new Map(matchups.map((m) => [`${m.a}:${m.b}`, m]));
  const header = standings.map((row) => `<th scope="col" title="${escapeHtml(row.name)}">${escapeHtml(shortName(row.name))}</th>`).join("");
  const body = standings.map((row) => {
    const cells = standings.map((column) => {
      if (row.id === column.id) return '<td class="diagonal">—</td>';
      const low = Math.min(row.id, column.id);
      const high = Math.max(row.id, column.id);
      const matchup = byPair.get(`${low}:${high}`);
      if (!matchup || matchup.games === 0) return '<td class="empty">·</td>';
      const score = row.id === low ? matchup.aScore : 1 - matchup.aScore;
      const wins = row.id === low ? matchup.aWins : matchup.bWins;
      const losses = row.id === low ? matchup.bWins : matchup.aWins;
      const hue = Math.round(score * 120);
      return `<td class="score" style="background:hsl(${hue} 55% 24%)" title="${escapeHtml(row.name)} vs ${escapeHtml(column.name)}: ${wins}-${matchup.draws}-${losses}">${Math.round(score * 100)}<span class="tiny">%</span></td>`;
    }).join("");
    return `<tr><th scope="row">${escapeHtml(row.name)}</th>${cells}</tr>`;
  }).join("");
  return `<div class="scroll"><table class="matrix"><thead><tr><th scope="col">row score vs column</th>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function shortName(name) {
  return name.length > 16 ? `${name.slice(0, 15)}…` : name;
}

export function renderHtml(report) {
  const { meta, totals, standings, matchups } = report;
  const ranked = [...standings].sort((x, y) => {
    if (x.elo == null && y.elo == null) return x.name.localeCompare(y.name);
    if (x.elo == null) return 1;
    if (y.elo == null) return -1;
    return y.elo - x.elo;
  });

  const leaderboard = ranked.map((row, index) => `
    <tr>
      <td class="rank">${row.games ? index + 1 : "—"}</td>
      <td class="participant"><span class="dot ${row.kind}"></span><b>${escapeHtml(row.name)}</b><span class="kind">${row.kind}</span></td>
      <td class="num">${eloCell(row)}</td>
      <td class="num">${row.games ? pct(row.score) : "—"}${row.games ? ` <span class="muted">[${pct(row.scoreCI[0])}, ${pct(row.scoreCI[1])}]</span>` : ""}</td>
      <td class="num">${row.wins}-${row.draws}-${row.losses}</td>
      <td class="num">${row.games}</td>
      <td class="num">${row.games ? num(row.damageDealt / row.games, 0) : "—"}</td>
      <td class="num">${row.games ? num(row.damageTaken / row.games, 0) : "—"}</td>
      <td class="num ${row.tickErrors ? "bad" : ""}">${row.tickErrors}</td>
    </tr>`).join("");

  const matchupRows = [...matchups].sort((x, y) => x.aName.localeCompare(y.aName) || x.bName.localeCompare(y.bName)).map((m) => `
    <tr>
      <td><b>${escapeHtml(m.aName)}</b> vs <b>${escapeHtml(m.bName)}</b></td>
      <td class="num">${m.games}</td>
      <td class="num">${m.aWins}</td>
      <td class="num">${m.draws}</td>
      <td class="num">${m.bWins}</td>
      <td class="num">${pct(m.aScore)} <span class="muted">[${pct(m.aScoreCI[0])}, ${pct(m.aScoreCI[1])}]</span></td>
    </tr>`).join("");

  const verifyLine = totals.verified + totals.verifyFailed === 0
    ? "No replays were sampled for verification in this run."
    : `${totals.verified}/${totals.verified + totals.verifyFailed} sampled replays re-simulated and matched their recorded hashes.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>battle.training tournament — ${escapeHtml(meta.rules.version)}</title>
<style>
  :root {
    --bg: #0b0f14; --panel: #111821; --panel-2: #0e141c; --line: #22303f;
    --text: #e6edf3; --muted: #8b98a5; --accent: #e4572e; --blue: #5b8def;
    --green: #2ea043; --red: #da3633; --track: #1a2431;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 40px 24px 64px; }
  .eyebrow { color: var(--accent); font-weight: 650; letter-spacing: .08em; text-transform: uppercase; font-size: 12px; }
  h1 { font-size: 34px; line-height: 1.15; margin: 8px 0 14px; letter-spacing: -.02em; }
  h2 { font-size: 19px; margin: 42px 0 6px; letter-spacing: -.01em; }
  h2 + .sub { margin: 0 0 14px; }
  .sub, .muted { color: var(--muted); }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0 0; }
  .chip { background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 5px 12px; color: var(--muted); font-size: 12.5px; }
  .chip b { color: var(--text); font-weight: 600; }
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 28px 0 0; }
  .stat { background: linear-gradient(180deg, var(--panel), var(--panel-2)); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
  .stat .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
  .stat .value { font-size: 26px; font-weight: 700; margin-top: 4px; }
  .stat .hint { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 11px 14px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
  thead th { color: var(--muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; font-weight: 600; background: var(--panel-2); }
  tbody tr:last-child td, tbody tr:last-child th { border-bottom: 0; }
  tbody tr:hover { background: #141d28; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .rank { color: var(--muted); width: 42px; }
  .participant .kind { color: var(--muted); font-size: 11px; margin-left: 8px; border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; background: var(--accent); }
  .dot.house { background: var(--blue); }
  .bad { color: var(--red); font-weight: 650; }
  .chart { width: 100%; height: auto; display: block; }
  .chart .track { fill: var(--track); }
  .chart .baseline { stroke: #3b4a5c; stroke-width: 1; stroke-dasharray: 3 4; }
  .chart .whisker { stroke: #c9d4df; stroke-width: 1.6; }
  .chart .name { fill: var(--text); font-size: 12.5px; }
  .chart .value { fill: var(--text); font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .chart .axis { fill: var(--muted); font-size: 10.5px; }
  .matrix th, .matrix td { text-align: center; padding: 9px 10px; }
  .matrix tbody th { text-align: left; font-weight: 600; }
  .matrix .diagonal { background: #0c1219; color: #3b4a5c; }
  .matrix .empty { color: #3b4a5c; }
  .matrix .score { font-variant-numeric: tabular-nums; font-weight: 600; }
  .matrix .tiny { font-size: 10px; opacity: .7; }
  .legend { display: flex; gap: 18px; flex-wrap: wrap; margin: 10px 0 0; color: var(--muted); font-size: 12.5px; }
  .legend span { display: inline-flex; align-items: center; gap: 7px; }
  details { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; margin-top: 12px; }
  details summary { cursor: pointer; font-weight: 650; }
  details ul { margin: 12px 0 0; padding-left: 20px; color: var(--muted); }
  details li { margin: 6px 0; }
  code { background: #0a1017; border: 1px solid var(--line); border-radius: 5px; padding: 1px 6px; font-size: 12.5px; color: #d6e2ee; }
  footer { margin-top: 46px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); padding-top: 16px; }
  @media (max-width: 760px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } h1 { font-size: 27px; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">battle.training · local tournament</div>
    <h1>${ranked.length} participants, ${totals.played} matches, one ranking</h1>
    <p class="sub">Round-robin with mirrored sides on the arena's own engine. Scores and Elo carry 95% intervals, because small samples lie.</p>
    <div class="chips">
      <span class="chip">rules <b>${escapeHtml(meta.rules.version)}</b></span>
      <span class="chip">engine <b>${escapeHtml(meta.engine)}</b></span>
      <span class="chip">seeds <b>${meta.config.seeds}</b>${meta.config.family ? ` · <b>${escapeHtml(meta.config.family)}</b>` : ""}</span>
      <span class="chip">generated <b>${escapeHtml(meta.generatedAt.replace("T", " ").replace(/\..+/, " UTC"))}</b></span>
    </div>
  </header>

  <section class="stats">
    <div class="stat"><div class="label">Matches played</div><div class="value">${totals.played}</div><div class="hint">${totals.failed} failed</div></div>
    <div class="stat"><div class="label">Participants</div><div class="value">${standings.length}</div><div class="hint">${standings.filter((r) => r.kind === "controller").length} controllers · ${standings.filter((r) => r.kind === "house").length} house bots</div></div>
    <div class="stat"><div class="label">Draws</div><div class="value">${totals.draws}</div><div class="hint">counted as half a win</div></div>
    <div class="stat"><div class="label">Replays verified</div><div class="value">${totals.verified}${totals.verifyFailed ? `<span class="bad"> +${totals.verifyFailed} failed</span>` : ""}</div><div class="hint">hash-checked by the arena</div></div>
  </section>

  <h2>Leaderboard</h2>
  <p class="sub">Elo from a Bradley–Terry fit; score is wins plus half of the draws over games. Intervals are 95%.</p>
  <div class="panel scroll">
    <table>
      <thead><tr>
        <th scope="col">#</th><th scope="col">Participant</th><th scope="col" class="num">Elo [95% CI]</th>
        <th scope="col" class="num">Score [95% CI]</th><th scope="col" class="num">W-D-L</th><th scope="col" class="num">Games</th>
        <th scope="col" class="num">Dmg dealt/g</th><th scope="col" class="num">Dmg taken/g</th><th scope="col" class="num">Tick errors</th>
      </tr></thead>
      <tbody>${leaderboard}
      </tbody>
    </table>
  </div>

  <h2>Elo with uncertainty</h2>
  <p class="sub">Bar length is the rating; the whisker is the 95% bootstrap interval over games. House bots are blue.</p>
  <div class="panel" style="padding:18px 16px">${eloChart(ranked)}</div>

  <h2>Head to head</h2>
  <p class="sub">Each cell is the row participant's score against the column participant. Hover for the W-D-L record.</p>
  <div class="panel">${headToHead(standings, matchups)}</div>

  <h2>Matchups</h2>
  <p class="sub">The same numbers with counts and intervals, for copying into a tuning note.</p>
  <div class="panel scroll">
    <table>
      <thead><tr><th scope="col">Pairing</th><th scope="col" class="num">Games</th><th scope="col" class="num">A wins</th><th scope="col" class="num">Draws</th><th scope="col" class="num">B wins</th><th scope="col" class="num">A score [95% CI]</th></tr></thead>
      <tbody>${matchupRows || '<tr><td colspan="6" class="muted">No matchups.</td></tr>'}
      </tbody>
    </table>
  </div>

  <details>
    <summary>Method and reproducibility</summary>
    <ul>
      <li>Every unordered pair plays every seed from both sides, so map and side bias cancel instead of deciding the ranking.</li>
      <li>Seeds are deterministic: <code>seed = (s * 2654435761) mod 2^32</code>, the same rule the official local-test uses.${meta.config.seedList?.length ? ` Seeds: <code>${meta.config.seedList.join(", ")}</code>.` : ""}</li>
      <li>Score = <code>(wins + 0.5 * draws) / games</code>; the interval is a 95% Wilson score interval.</li>
      <li>Elo = <code>1500 + 400 * log10(strength)</code> from a Bradley–Terry fit (MM algorithm). A 0.25 pseudo-win / 0.5 pseudo-game prior keeps undefeated and winless ratings finite. The interval is a ${meta.config.bootstrap}-resample bootstrap over games.</li>
      <li>Each controller is evaluated in a fresh VM context per match, so module-level state cannot leak between games.</li>
      <li>${escapeHtml(verifyLine)}</li>
      <li>Reproduce: <code>${escapeHtml(meta.command)}</code></li>
    </ul>
  </details>

  <footer>
    Generated by ${escapeHtml(meta.harness)} against battle.training engine ${escapeHtml(meta.engine)} · rules hash ${escapeHtml(meta.rules.hash ?? "—")}.
    Not affiliated with battle.training. Results are local simulations; the public ladder is the final judge.
  </footer>
</div>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* Console output                                                      */
/* ------------------------------------------------------------------ */

function printSummary(report, opt) {
  const { meta, totals, standings, matchups } = report;
  const ranked = [...standings].sort((x, y) => (y.elo ?? -1e9) - (x.elo ?? -1e9));
  console.log("");
  console.log(`=== bt-tournament ${HARNESS_VERSION} · ${meta.rules.version} · engine ${meta.engine} ===`);
  console.log(`participants ${standings.length} · games ${totals.played}/${totals.planned} · seeds ${meta.config.seeds} x2 sides · draws ${totals.draws}`);
  if (totals.verified + totals.verifyFailed > 0) {
    console.log(`replays verified ${totals.verified}/${totals.verified + totals.verifyFailed}`);
  }
  if (totals.failed > 0) console.log(`failed games ${totals.failed} (see report.json)`);
  console.log("");
  const nameWidth = Math.min(28, Math.max(10, ...ranked.map((row) => row.name.length)));
  console.log(`${"#".padStart(2)}  ${"participant".padEnd(nameWidth)}  ${"elo".padStart(5)} ${"95% CI".padStart(13)}  ${"score".padStart(6)}  ${"W-D-L".padStart(7)}  ${"games".padStart(5)}  ${"err".padStart(3)}`);
  ranked.forEach((row, index) => {
    const ci = row.eloCI ? `[${Math.round(row.eloCI[0])},${Math.round(row.eloCI[1])}]` : "—";
    console.log(
      `${String(row.games ? index + 1 : "—").padStart(2)}  ${row.name.padEnd(nameWidth)}  ${row.elo == null ? "—" : String(Math.round(row.elo)).padStart(5)} ${ci.padStart(13)}  ${row.games ? pct(row.score) : "—"}  ${`${row.wins}-${row.draws}-${row.losses}`.padStart(7)}  ${String(row.games).padStart(5)}  ${String(row.tickErrors).padStart(3)}`
    );
  });
  console.log("");
  for (const m of matchups) {
    console.log(`  ${m.aName} vs ${m.bName}: ${m.aWins}-${m.draws}-${m.bWins} (${m.games}g, A score ${pct(m.aScore)})`);
  }
  if (!opt.quiet) {
    console.log("");
    console.log(`wrote ${join(opt.out, "report.json")}`);
    if (opt.html) console.log(`wrote ${join(opt.out, "report.html")}`);
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(2);
  }
  if (opt.help) {
    console.log(USAGE);
    return;
  }

  const rules = resolveRules(opt.rules);
  if (opt.family && !rules.urban) {
    throw new Error("--family needs --rules urban");
  }
  for (const style of opt.vs) {
    if (!HOUSE_STYLES.includes(style)) {
      throw new Error(`unknown house bot "${style}"; use ${HOUSE_STYLES.join(", ")}`);
    }
  }

  const participants = [];
  const usedNames = new Set();
  for (const file of opt.controllers) {
    const path = resolve(file);
    const source = readFileSync(path, "utf8");
    let name = basename(path, extname(path));
    if (usedNames.has(name)) {
      let n = 2;
      while (usedNames.has(`${name}-${n}`)) n++;
      name = `${name}-${n}`;
    }
    usedNames.add(name);
    participants.push({
      name,
      kind: "controller",
      file: path,
      source,
      version: `sha256:${createHash("sha256").update(source).digest("hex").slice(0, 12)}`,
    });
  }
  for (const style of opt.vs) {
    const name = `house-${style}`;
    if (usedNames.has(name)) throw new Error(`participant name collision: ${name}`);
    usedNames.add(name);
    participants.push({ name, kind: "house", style, version: `house-${style}` });
  }
  if (participants.length < 2) {
    throw new Error("need at least two participants: controllers and/or --vs house bots");
  }

  const { jobs, seedList } = buildPlan(participants, opt.seeds, rules, opt.family);

  // Deterministic samples: evenly spaced games, so the sample spans the whole plan.
  const sampleEvenly = (count) => {
    if (count === "all") return jobs.map((job) => job.id);
    if (!count) return [];
    const picked = [];
    const step = jobs.length / count;
    for (let i = 0; i < count; i++) picked.push(jobs[Math.min(jobs.length - 1, Math.floor(i * step))].id);
    return [...new Set(picked)];
  };
  const verifyIds = sampleEvenly(opt.verify);
  const saveIds = opt.saveReplays ? jobs.slice(0, opt.saveLimit).map((job) => job.id) : [];

  const outDir = resolve(opt.out);
  mkdirSync(outDir, { recursive: true });
  const saveDir = opt.saveReplays ? resolve(opt.saveReplays) : outDir;
  if (opt.saveReplays) mkdirSync(saveDir, { recursive: true });

  console.log(`bt-tournament ${HARNESS_VERSION}: ${participants.length} participants, ${jobs.length} games (${seedList.length} seeds x2 sides), rules ${rules.version}`);
  if (!opt.quiet) console.log(`workers ${opt.workers} · bootstrap ${opt.bootstrap} · verify ${verifyIds.length || "off"}${saveIds.length ? ` · saving ${saveIds.length} replays` : ""}`);

  const results = await runWorkers({
    participants,
    jobs,
    opt,
    verifyIds,
    saveIds,
    saveDir,
  });

  const report = aggregate({
    participants,
    jobs,
    results,
    rules,
    config: {
      seeds: seedList.length,
      seedList,
      family: opt.family,
      workers: opt.workers,
      bootstrap: opt.bootstrap,
      maxTicks: opt.maxTicks,
      command: `node bt-tournament.mjs ${process.argv.slice(2).join(" ")}`.trim(),
    },
  });

  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (opt.html) writeFileSync(join(outDir, "report.html"), renderHtml(report));
  printSummary(report, { ...opt, out: outDir });
}

const invokedDirectly = isMainThread
  && process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (!isMainThread) {
  workerMain();
} else if (invokedDirectly) {
  main().catch((error) => {
    console.error(`error: ${error?.message ?? error}`);
    process.exit(1);
  });
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "bot";
}
