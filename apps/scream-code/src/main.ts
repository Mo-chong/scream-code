/**
 * Scream Code entry point.
 *
 * This file is intentionally tiny: it attaches startup side-effects (like
 * suppressing the Node SQLite experimental warning) before any heavy
 * dependencies are loaded, then hands off to `./app.ts`.
 *
 * It also runs the BUILD_TIMESTAMP guard — a runtime freshness check that
 * warns when the bundle is more than 24 hours old (a common pitfall when
 * editing source files and forgetting to rebuild).
 */

/** Replaced at build time by tsdown `define` — emits ms timestamp. */
declare const __BUILD_TIMESTAMP__: number;

import './utils/suppress-sqlite-warning.js';

// ---- guard: bundle freshness ----
const BUILD_TIME: number = __BUILD_TIMESTAMP__;
const ageMs = Date.now() - BUILD_TIME;
const ageHours = ageMs / 3_600_000;

process.stderr.write(`[scream] bundle 构建时间: ${new Date(BUILD_TIME).toISOString()}\n`);
if (ageHours > 24) {
  process.stderr.write(
    `[guard] ⚠️  bundle 已构建超过 ${Math.round(ageHours)} 小时，推荐使用 ./bin/scream-dev 启动。\n`,
  );
}

try {
  const app = await import('./app.js');
  app.main();
} catch (error) {
  // The app has its own error handlers; this catches module-load failures.
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}
