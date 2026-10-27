// Checkpoint granularity is not invocation granularity. Each small durable
// chunk remains independently resumable; the same owner may process more chunks.
const MAX_BATCH_MS = 210000;
const MAX_BATCH_RSS = 640 * 1024 * 1024;
const MAX_BATCH_HEAP = 384 * 1024 * 1024;
const MAX_BATCH_CHUNKS = 32;
function yieldReason({ elapsedMs, rss, heapUsed, chunks, lastChunkMs = 0 }) {
  if (chunks >= MAX_BATCH_CHUNKS) return 'chunk-bound';
  if (rss >= MAX_BATCH_RSS || heapUsed >= MAX_BATCH_HEAP) return 'memory-budget';
  if (elapsedMs + Math.max(15000, lastChunkMs * 1.5) >= MAX_BATCH_MS) return 'time-budget';
  return null;
}
async function runCalculationChunks(context, options) {
  const { calculate, now = Date.now, memory = process.memoryUsage } = options;
  const shared = {}; let chunks = 0, reason = 'stage-boundary', lastChunkMs = 0;
  while (['numeric', 'ratio'].includes(context.state.stage)) {
    if (chunks) {
      const usage = memory();
      reason = yieldReason({ elapsedMs: now() - context.started, ...usage, chunks, lastChunkMs });
      if (reason) break;
    }
    const before = `${context.state.stage}:${context.state.cursor}`;
    const start = now();
    await calculate({ ...context, shared });
    lastChunkMs = now() - start; chunks++;
    if (`${context.state.stage}:${context.state.cursor}` === before)
      throw Object.assign(new Error('Calculation did not advance its durable checkpoint.'), { code: 'INSTANT_NO_PROGRESS' });
    reason = 'stage-boundary';
  }
  context.log('instant-calculation-batch-completed', { chunks, yieldReason: reason,
    phase: context.state.stage, cursor: context.state.cursor, elapsedMs: now() - context.started, ...memory() });
  return { chunks, reason };
}
module.exports = { runCalculationChunks, yieldReason, MAX_BATCH_MS, MAX_BATCH_RSS, MAX_BATCH_HEAP, MAX_BATCH_CHUNKS };
