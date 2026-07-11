#!/usr/bin/env node
import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';
import { dirname as __cjsShimDirname } from 'node:path';
const __filename = __cjsShimFileURLToPath(import.meta.url);
const __dirname = __cjsShimDirname(__filename);
//#region src/utils/suppress-sqlite-warning.ts
/**
* Suppress Node's ExperimentalWarning for the built-in `node:sqlite` module.
*
* Node emits this warning while `node:sqlite` is loaded as a transitive
* dependency during ESM module evaluation, before any app code can intercept
* it via `process.emitWarning` or `process.on('warning')`. We filter the known
* warning text from stderr to keep startup output clean.
*/
const originalWrite = process.stderr.write.bind(process.stderr);
let expectingTraceSuggestion = false;
function isSQLiteExperimentalWarning(line) {
	return /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature/.test(line);
}
function isTraceSuggestion(line) {
	return line.startsWith("(Use `node --trace-warnings");
}
process.stderr.write = (chunk, ...args) => {
	const lines = (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")).split("\n");
	let changed = false;
	const kept = [];
	for (const line of lines) {
		if (isSQLiteExperimentalWarning(line)) {
			expectingTraceSuggestion = true;
			changed = true;
			continue;
		}
		if (expectingTraceSuggestion && isTraceSuggestion(line)) {
			expectingTraceSuggestion = false;
			changed = true;
			continue;
		}
		expectingTraceSuggestion = false;
		kept.push(line);
	}
	if (changed) {
		const filtered = kept.join("\n");
		if (filtered.length === 0) {
			args.find((a) => typeof a === "function")?.();
			return true;
		}
		return originalWrite(filtered, ...args);
	}
	return originalWrite(chunk, ...args);
};
//#endregion
export {};
