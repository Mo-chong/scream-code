#!/usr/bin/env node
import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';
import { dirname as __cjsShimDirname } from 'node:path';
const __filename = __cjsShimFileURLToPath(import.meta.url);
const __dirname = __cjsShimDirname(__filename);
import "./suppress-sqlite-warning-C2VB0doZ.mjs";
//#region src/main.ts
const BUILD_TIME = 1783775968115;
const ageHours = (Date.now() - BUILD_TIME) / 36e5;
process.stderr.write(`[scream] bundle 构建时间: ${(/* @__PURE__ */ new Date(BUILD_TIME)).toLocaleString("zh-CN", {
	timeZone: "Asia/Shanghai",
	hour12: false
})}\n`);
if (ageHours > 24) process.stderr.write(`[guard] ⚠️  bundle 已构建超过 ${Math.round(ageHours)} 小时，推荐使用 ./bin/scream-dev 启动。\n`);
try {
	(await import("./app-CLpzeIh5.mjs")).main();
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exit(1);
}
//#endregion
export {};
