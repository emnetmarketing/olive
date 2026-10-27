const test = require('node:test');
const assert = require('node:assert/strict');
const budget = require('../netlify/functions/instant-execution-budget');

function fixture(extra = {}) {
  let clock = 0; const state = { stage: 'numeric', cursor: 0 }, saved = [], events = [], resources = [];
  return { state, saved, events, context: { state, started: 0, log: (event, detail) => events.push({ event, ...detail }) },
    options: { now: () => clock, memory: () => ({ rss: 200 * 1024 ** 2, heapUsed: 80 * 1024 ** 2 }),
      calculate: async ({ state, shared }) => { resources.push(shared); clock += 6000;
        state.cursor = Math.min(5000, state.cursor + 250); saved.push(state.cursor);
        if (state.cursor === 5000) { state.stage = 'enrichment'; state.cursor = 0; }
      }, ...extra }, resources };
}
test('5000 candidates keep 20 checkpoints but need only one bounded calculation invocation', async () => {
  const f = fixture(); const result = await budget.runCalculationChunks(f.context, f.options);
  assert.equal(result.chunks, 20); assert.equal(result.reason, 'stage-boundary');
  assert.deepEqual(f.saved, Array.from({ length: 20 }, (_, i) => (i + 1) * 250));
  assert.equal(new Set(f.resources).size, 1); assert.equal(f.state.stage, 'enrichment');
});
test('time headroom yields only after a durable checkpoint and resumes the saved cursor', async () => {
  const f = fixture(); f.context.started = -170000;
  const first = await budget.runCalculationChunks(f.context, f.options);
  assert.ok(first.chunks > 0 && first.chunks < 20); assert.equal(first.reason, 'time-budget');
  const saved = f.saved.at(-1); f.context.started = f.options.now();
  await budget.runCalculationChunks(f.context, f.options);
  assert.equal(new Set(f.saved).size, 20); assert.equal(f.saved[ first.chunks - 1 ], saved);
});
test('RSS or heap pressure yields at the last saved chunk without unbounded accumulation', async () => {
  for (const usage of [{ rss: budget.MAX_BATCH_RSS, heapUsed: 1 }, { rss: 1, heapUsed: budget.MAX_BATCH_HEAP }]) {
    const f = fixture({ memory: () => usage });
    const result = await budget.runCalculationChunks(f.context, f.options);
    assert.equal(result.reason, 'memory-budget'); assert.equal(result.chunks, 1); assert.equal(f.saved[0], 250);
  }
});
test('interruption after committed chunk preserves the cursor for the next owner', async () => {
  const f = fixture(), calculate = f.options.calculate;
  f.options.calculate = async ctx => { await calculate(ctx); if (ctx.state.cursor === 500) throw Error('simulated worker termination'); };
  await assert.rejects(budget.runCalculationChunks(f.context, f.options), /termination/);
  assert.equal(f.state.cursor, 500); f.options.calculate = calculate;
  await budget.runCalculationChunks(f.context, f.options);
  assert.equal(new Set(f.saved).size, 20); assert.equal(f.saved.length, 20);
});
test('no-progress and chunk bound cannot create an infinite worker loop', async () => {
  const f = fixture({ calculate: async () => {} });
  await assert.rejects(budget.runCalculationChunks(f.context, f.options), { code: 'INSTANT_NO_PROGRESS' });
  assert.equal(budget.yieldReason({ elapsedMs: 0, rss: 1, heapUsed: 1, chunks: 32 }), 'chunk-bound');
});
