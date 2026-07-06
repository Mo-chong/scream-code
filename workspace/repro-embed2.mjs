// Reproduction v2: test FlagEmbedding.init with local cache + timeout
const EMBED_INIT_TIMEOUT_MS = 30_000;

async function initWithTimeout(factory, label, ms = EMBED_INIT_TIMEOUT_MS) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return await Promise.race([factory(), timer]);
}

async function repro() {
  console.log('=== Attempt: FlagEmbedding.init with cache ===');
  try {
    const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
    console.log('import OK, calling FlagEmbedding.init (with 30s timeout)...');
    const model = await initWithTimeout(
      () => FlagEmbedding.init({ model: EmbeddingModel.BGESmallZH }),
      'FlagEmbedding.init'
    );
    console.log('SUCCESS: model loaded');
    console.log('Model type:', typeof model);
    console.log('Model keys:', Object.keys(model).slice(0, 10));

    // Try embedding a test string
    if (typeof model.embed === 'function') {
      const result = await model.embed(['test sentence']);
      console.log('Embed result:', result);
    } else if (typeof model.embedBatch === 'function') {
      console.log('embedBatch available');
      const gen = model.embedBatch(['test sentence'], 1);
      const batch = [];
      for await (const b of gen) {
        batch.push(b);
      }
      console.log('embedBatch result length:', batch.length);
      if (batch.length > 0) console.log('First batch shape:', batch[0].length, batch[0][0].length);
    }
  } catch (e) {
    console.log('FAILED:', e.constructor.name, e.message);
    if (e.stack) console.log('STACK:', e.stack.split('\n').slice(0,6).join('\n'));
  }
}

repro().catch(e => console.log('TOPLEVEL:', e));
