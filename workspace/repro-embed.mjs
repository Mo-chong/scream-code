// Reproduction: reproduces what createFastEmbedEngine().embedBatch() does
// to see the actual error that gets swallowed.

const importMetaUrl = 'file:///d:/AI/ScreamCode/apps/scream-code/dist/main.mjs';

async function repro() {
  console.log('=== Attempt 1: bare import(\'fastembed\') ===');
  try {
    const mod = await import('fastembed');
    console.log('SUCCESS: imported fastembed, exports:', Object.keys(mod));
  } catch(e) {
    console.log('FAILED:', e.constructor.name, e.message);
    if (e.stack) console.log('STACK:', e.stack.split('\n').slice(0,4).join('\n'));
  }

  console.log('\n=== Attempt 2: createRequire(import.meta.url) resolve ===');
  try {
    const { createRequire } = await import('node:module');
    const distRequire = createRequire(importMetaUrl);
    const fePath = distRequire.resolve('fastembed/package.json');
    console.log('SUCCESS: resolved to', fePath);
  } catch(e) {
    console.log('FAILED:', e.constructor.name, e.message);
  }

  console.log('\n=== Attempt 3: actual FlagEmbedding.init ===');
  try {
    const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
    console.log('import OK, calling FlagEmbedding.init...');
    const model = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallZH });
    console.log('SUCCESS: model loaded');
  } catch(e) {
    console.log('FAILED:', e.constructor.name, e.message);
    if (e.stack) console.log('STACK:', e.stack.split('\n').slice(0,6).join('\n'));
  }
}

repro().catch(e => console.log('TOPLEVEL:', e));
