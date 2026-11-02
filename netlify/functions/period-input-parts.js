// Frozen data belongs to one Period Job. Never hash, JSON-encode, upload or
// reread the entire multi-source object in a single allocation. Each part is
// immutable and verified before the existing lease CAS can expose its manifest.
const crypto = require('node:crypto');
const FORMAT = 'period-input-parts-v1';
const PART_BYTES = 2 * 1024 * 1024;
const ROW_BATCH = 256;
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const problem = () => Object.assign(new Error('Saved period input part is missing or changed.'), { code: 'PERIOD_ARTIFACT_INTEGRITY' });
const baseKey = id => `jobs/${encodeURIComponent(id)}/input-parts/v1/`;

async function writeParts(store, jobId, inputs, { maxBytes = PART_BYTES, metrics = {} } = {}) {
  const manifest = { format: FORMAT, jobId, tree: null, partCount: 0, storedBytes: 0 };
  const now = () => performance.now(), begin = now();
  Object.assign(metrics, { hashMs: 0, writeMs: 0, verifyReadMs: 0, verifyHashMs: 0, maxPartBytes: 0, observedRssBytes: 0 });
  async function saveText(text) {
    const t0 = now();
    const digest = hash(text), bytes = Buffer.byteLength(text);
    const key = baseKey(jobId) + digest;
    const t1 = now(); metrics.hashMs += t1 - t0;
    // A JSON string envelope keeps verification byte-for-byte across storage
    // implementations (the service need not preserve an object's key order).
    await store.setJSON(key, { text }, { onlyIfNew: true });
    const t2 = now(); metrics.writeMs += t2 - t1;
    const saved = await store.get(key, { type: 'json' });
    const t3 = now(); metrics.verifyReadMs += t3 - t2;
    if (typeof saved?.text !== 'string' || hash(saved.text) !== digest) throw problem();
    metrics.verifyHashMs += now() - t3;
    metrics.maxPartBytes = Math.max(metrics.maxPartBytes, bytes);
    metrics.observedRssBytes = Math.max(metrics.observedRssBytes, process.memoryUsage().rss);
    manifest.partCount++; manifest.storedBytes += bytes;
    return digest;
  }
  async function encode(value) {
    if (Array.isArray(value)) {
      if (value.length <= 12) {
        const small = JSON.stringify(value);
        if (Buffer.byteLength(small) <= 2048) return { scalar: JSON.parse(small) };
      }
      const parts = [];
      // A batch of rows is serialised one row at a time so a large source
      // history cannot accidentally create a full-size trial JSON string.
      let strings = [], bytes = 2;
      const flush = async () => {
        if (!strings.length) return;
        parts.push(await saveText('[' + strings.join(',') + ']')); strings = []; bytes = 2;
      };
      for (const row of value) {
        const text = JSON.stringify(row) ?? 'null', size = Buffer.byteLength(text) + 1;
        if (strings.length && (bytes + size > maxBytes || strings.length >= 4096)) await flush();
        if (size > maxBytes) throw Object.assign(new Error('One period input record exceeds the bounded part size.'), { code: 'PERIOD_INPUT_ROW_SIZE' });
        strings.push(text); bytes += size;
      }
      await flush();
      return { array: parts, length: value.length };
    }
    if (value && typeof value === 'object') {
      const fields = [];
      for (const [key, member] of Object.entries(value)) {
        if (member === undefined) continue;
        // Small diagnostic/metadata objects stay in the manifest; source row
        // arrays always use verified parts.
        fields.push([key, await encode(member)]);
      }
      return { object: fields };
    }
    return { scalar: value ?? null };
  }
  manifest.tree = await encode(inputs);
  metrics.encodeAndPackMs = now() - begin - metrics.hashMs - metrics.writeMs - metrics.verifyReadMs - metrics.verifyHashMs;
  for (const metric of Object.keys(metrics)) metrics[metric] = Math.round(metrics[metric]);
  return manifest;
}

async function readParts(store, jobId, manifest) {
  if (manifest?.format !== FORMAT || manifest.jobId !== jobId) throw problem();
  let count = 0, bytes = 0;
  async function decode(node) {
    if (node && Object.hasOwn(node, 'scalar')) return node.scalar;
    if (Array.isArray(node?.object)) {
      const fields = [];
      for (const [key, member] of node.object) fields.push([key, await decode(member)]);
      return Object.fromEntries(fields);
    }
    if (!Array.isArray(node?.array) || !Number.isSafeInteger(node.length) || node.length < 0) throw problem();
    const values = [];
    for (const digest of node.array) {
      if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw problem();
      const part = await store.get(baseKey(jobId) + digest, { type: 'json' });
      if (typeof part?.text !== 'string' || hash(part.text) !== digest) throw problem();
      const items = JSON.parse(part.text); if (!Array.isArray(items)) throw problem();
      for (let i = 0; i < items.length; i += ROW_BATCH) values.push(...items.slice(i, i + ROW_BATCH));
      count++; bytes += Buffer.byteLength(part.text);
    }
    if (values.length !== node.length) throw problem();
    return values;
  }
  const result = await decode(manifest.tree);
  if (count !== manifest.partCount || bytes !== manifest.storedBytes) throw problem();
  return result;
}
module.exports = { FORMAT, writeParts, readParts };
