// battle.training starter controller (JavaScript)
//
// Your controller is an object with two functions, plus an optional third. The arena calls hello()
// once with the rules and the full map, then tick() twenty times a second with what your squad can
// see. You return orders. All positions are fixed-point: tiles × 65536. Angles are 0..4095 for a
// full turn, 0 = east, increasing clockwise (towards south). Everything is integers.
//
// Season 2 ("Drafted"): draft(h) runs before hello() with the same h (map, rules, h.draft.roster /
// costs / budget / min / max) and returns 3–5 unit kinds whose costs fit h.draft.budget. This starter
// drafts two tanks and two scouts (12 points) when a draft is offered; without a draft() the default
// squad (scout + MBT + artillery, 10 points) plays. If you draft other kinds, handle them in tick():
// drones have no gun, missile carriers need `target` every tick until locked, engineers use
// `ability: "smoke" | "mine"`. See docs/controller-api.md.
//
// This starter does three things: drives every unit towards the most valuable objective it does not
// hold (weight over distance; the centre of the map when there are no objectives) while steering
// around water, rock and ruins, points guns at the nearest visible enemy, and fires when ready. It
// loses to anything smarter. That is the point.

const FP = 65536;
const FULL = 4096;

let rules, map, side, hill;

function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
function angleTo(ax, ay, bx, by) { return Math.round((Math.atan2(by - ay, bx - ax) / (2 * Math.PI)) * FULL) & (FULL - 1); }
function angDiff(a, b) { let d = (b - a) & (FULL - 1); return d > FULL / 2 ? d - FULL : d; }
function passable(x, y) {
  const tx = Math.floor(x / FP), ty = Math.floor(y / FP);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return false;
  const t = map.terrain[ty * map.width + tx];
  return t !== 2 && t !== 4 && t !== 6; // 2 water, 4 rock, 6 ruin
}
/** the objective worth driving to: highest weight per tile of distance, skipping the ones we already hold */
function pickObjective(objectives, x, y) {
  let best = null, score = -1;
  for (const o of objectives || []) {
    if (o.owner === side && o.state === "held") continue;
    const s = o.weight / (1 + dist(x, y, o.x, o.y) / FP);
    if (s > score) { score = s; best = o; }
  }
  return best ? [best.x, best.y] : hill;
}

globalThis.controller = {
  draft(h) {
    const d = h.draft;
    if (!d) return undefined;
    const pick = ["mbt", "mbt", "scout", "scout"];
    const cost = pick.reduce((c, k) => c + (d.costs[k] ?? 99), 0);
    return cost <= d.budget && pick.every(k => d.roster.includes(k)) ? pick : undefined;
  },

  hello(h) {
    rules = h.rules; map = h.map; side = h.side;
    hill = [Math.floor(map.width / 2) * FP + FP / 2, Math.floor(map.height / 2) * FP + FP / 2];
  },

  tick(o) {
    const units = [];
    for (const u of o.units) {
      if (!u.alive) continue;
      const spec = rules.units[u.kind];
      const order = { id: u.id };

      // nearest contact
      let target = null, best = Infinity;
      for (const c of o.contacts) { const d = dist(u.x, u.y, c.x, c.y); if (d < best) { best = d; target = c; } }

      // movement: towards the best objective, unless an enemy is close enough to shoot
      let goal = pickObjective(o.objectives, u.x, u.y);
      if (target && best < spec.gun.maxRange * 0.8 && u.kind !== "scout") goal = null;
      if (u.kind === "artillery") goal = target && best < spec.gun.minRange * 1.5 ? [u.x * 2 - target.x, u.y * 2 - target.y] : null;
      if (goal && o.canMove) {
        let want = angleTo(u.x, u.y, goal[0], goal[1]);
        // steer around obstacles: try the wanted heading, then fan out
        const offsets = [0, 341, -341, 683, -683, 1024, -1024];
        for (const off of offsets) {
          const a = (want + off) & (FULL - 1);
          const rad = (a / FULL) * 2 * Math.PI;
          if (passable(u.x + Math.cos(rad) * FP * 1.5, u.y + Math.sin(rad) * FP * 1.5)) { want = a; break; }
        }
        const d = angDiff(u.heading, want);
        order.steer = Math.max(-FP, Math.min(FP, Math.round((d / spec.turnRate) * FP)));
        order.throttle = Math.abs(d) > 512 ? Math.round(FP * 0.2) : FP;
        if (u.blocked) { order.throttle = -FP; order.steer = FP; }
      }

      // weapons (drones and engineers have no main gun; the engineer's MG fires with fire: true)
      if (target) {
        if (spec.gun.mode === "none") {
          if (spec.secondary && u.reload2 === 0 && best <= spec.secondary.maxRange) order.fire = true;
        } else if (spec.gun.mode === "direct") {
          order.aimAt = [target.x, target.y];
          const aimed = Math.abs(angDiff(u.turret, angleTo(u.x, u.y, target.x, target.y))) <= spec.gun.aimTolerance;
          if (u.reload === 0 && aimed && best <= spec.gun.maxRange) order.fire = true;
        } else if (u.reload === 0 && best >= spec.gun.minRange && best <= spec.gun.maxRange) {
          order.fire = [target.x, target.y];
        }
      }
      units.push(order);
    }
    return { units };
  },
};
