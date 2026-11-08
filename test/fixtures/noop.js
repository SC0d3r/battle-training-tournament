// Minimal controller fixture for the end-to-end test: never moves, never fires.
// The match runs to the tick cap, which is all the test needs.
globalThis.controller = {
  hello() {},
  tick(observation) {
    return { tick: observation.tick, units: [] };
  },
};
