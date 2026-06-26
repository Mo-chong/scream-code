/**
 * install-strategy.ts — Scream Code fork 的 Git 安装策略
 *
 * ═══════════════════════════════════════════════════════════════
 *  这个文件上游（LIUTod/scream-code）不存在，merge 时永远零冲突。
 * ═══════════════════════════════════════════════════════════════
 *
 *  用途：
 *  所有 fork 特有的更新逻辑集中在这里，包括安装源检测、版本检测、更新执行。
 *  将来上游改了更新方式（如 npm install -g），我们只需在 preflight.ts 里
 *  改一两行 import，install-strategy.ts 完全不受影响。
 *
 *  生命周期：
 *  创建后永不删除、永不重命名——只增不改，确保 merge 零冲突。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { valid } from 'semver';

import { resolveScreamHome } from '@scream-code/scream-code-sdk';
import { SCREAM_CODE_CDN_LATEST_URL, SCREAM_CODE_DATA_DIR_NAME } from '#/constant/app';

// ── 常量 ──────────────────────────────────────────────────

/** Git 远程名称，fork 用户可自定义 */
export const INSTALL_GIT_REMOTE = 'mochong';

/** Git 分支名称 */
export const INSTALL_GIT_BRANCH = 'main';

/** 用户提示中显示的安装命令 */
export const INSTALL_COMMAND_STRING = `cd ~/.scream-code && git pull ${INSTALL_GIT_REMOTE} ${INSTALL_GIT_BRANCH} && pnpm install && pnpm -r build`;

/** 手动更新失败提示 */
export const MANUAL_UPDATE_MESSAGE =
  `Scream Code 有新版本可用，自动更新失败。请手动执行：\n` +
  `  cd ~/.scream-code && git pull ${INSTALL_GIT_REMOTE} ${INSTALL_GIT_BRANCH} && pnpm install && pnpm -r build\n`;

// ── 安装源检测 ────────────────────────────────────────────

/**
 * 检测当前安装方式是否是源码安装（git clone）。
 *
 * 返回 'source' 时表示可以从 git 拉取更新；
 * 返回 'unsupported' 时无法自动更新（用户手动操作）。
 */
export function detectInstallSource(): 'source' | 'unsupported' {
  const installDir = resolveScreamHome();

  // 标准源码安装：安装目录下有 .git
  if (existsSync(join(installDir, '.git'))) {
    return 'source';
  }

  // 兼容旧版：~/.scream-code 路径
  const legacyDir = join(homedir(), SCREAM_CODE_DATA_DIR_NAME);
  if (legacyDir !== installDir && existsSync(join(legacyDir, '.git'))) {
    return 'source';
  }

  return 'unsupported';
}

// ── 版本检测（GitHub Releases API） ───────────────────────

/**
 * 从 GitHub Releases API 获取最新版本号。
 *
 * Throws 在失败时（网络异常、非 2xx、非 semver 标签），
 * 调用方必须 catch——refreshUpdateCache 利用这个特性
 * 避免因临时故障覆盖已有的缓存。
 */
export async function fetchLatestVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(SCREAM_CODE_CDN_LATEST_URL);
  if (!response.ok) {
    throw new Error(`GitHub Releases API returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as { tag_name?: string };
  const raw = data.tag_name?.replace(/^v/, '') ?? '';
  if (valid(raw) === null) {
    throw new Error(
      `GitHub Releases tag is not valid semver: ${JSON.stringify(data.tag_name)}`,
    );
  }
  return raw;
}

// ── 执行更新（git pull + pnpm install + pnpm build） ──────

/**
 * 执行完整的 git 源码更新流程：
 *   1. git pull <remote> <branch>
 *   2. pnpm install
 *   3. pnpm -r build
 *
 * 所有 spawn 调用使用 shell: true，确保 Windows 上
 * npm/pnpm 作为 .cmd 文件能正确解析。
 *
 * Throws 在任一命令失败时。
 */
export async function installUpdate(installDir: string): Promise<void> {
  const commands: readonly {
    readonly cmd: string;
    readonly args: readonly string[];
    readonly cwd?: string;
  }[] = [
    { cmd: 'git', args: ['pull', INSTALL_GIT_REMOTE, INSTALL_GIT_BRANCH], cwd: installDir },
    { cmd: 'pnpm', args: ['install'], cwd: installDir },
    { cmd: 'pnpm', args: ['-r', 'build'], cwd: installDir },
  ];

  for (const { cmd, args, cwd } of commands) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: true });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`${cmd} 失败（exit ${code ?? signal}）`));
      });
    });
  }
}
