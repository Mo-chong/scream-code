/**
 * QualityBaseline — qualityIndex 持久化与反馈回路
 *
 * 在 session-end 写入 qualityIndex 到 ~/.scream-code/quality-baseline.json，
 * 在 session-start 读取并决定注入策略：低分加约束，高分给自由。
 *
 * 不消耗 context token，不打断 AI。
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DIR = join(homedir(), '.scream-code');
const PATH = join(DIR, 'quality-baseline.json');

export interface QualityBaselineData {
  lastQualityIndex: number;
  previousScore: number;
  trend: 'stable' | 'improving' | 'declining';
  /** session 首次记录时间 */
  firstRecordedAt: string;
  /** 历史最高分 */
  peakScore: number;
  /** 总记录次数 */
  recordCount: number;
  /** 5 维评分详情（Phase42d 新增） */
  scores?: {
    deviation: number;
    convergence: number;
    toolAccuracy: number;
    faithfulness: number;
    debtHealth: number;
  };
}

const EMPTY: QualityBaselineData = {
  lastQualityIndex: 50,
  previousScore: 50,
  trend: 'stable',
  firstRecordedAt: new Date().toISOString(),
  peakScore: 0,
  recordCount: 0,
};

export function readBaseline(): QualityBaselineData {
  try {
    if (!existsSync(PATH)) return { ...EMPTY };
    return JSON.parse(readFileSync(PATH, 'utf-8')) as QualityBaselineData;
  } catch {
    return { ...EMPTY };
  }
}

export function writeBaseline(qualityIndex: number, scores?: QualityBaselineData['scores']): void {
  const prev = readBaseline();
  const trend: QualityBaselineData['trend'] =
    prev.recordCount === 0 ? 'stable' :
    qualityIndex > prev.lastQualityIndex + 3 ? 'improving' :
    qualityIndex < prev.lastQualityIndex - 3 ? 'declining' : 'stable';

  const data: QualityBaselineData = {
    lastQualityIndex: qualityIndex,
    previousScore: prev.lastQualityIndex,
    trend,
    firstRecordedAt: prev.firstRecordedAt || new Date().toISOString(),
    peakScore: Math.max(prev.peakScore, qualityIndex),
    recordCount: prev.recordCount + 1,
    scores,
  };

  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(PATH, JSON.stringify(data, null, 2));
  } catch {
    // 写失败不阻塞流程
  }
}

/** 根据 baseline 生成注入约束提示 */
export function getFeedbackInjection(data: QualityBaselineData): string | null {
  if (data.recordCount === 0) return null;

  // 🆕 Phase42d: 5 维具体反馈（替代 3 档模糊分）
  if (data.scores) {
    const { deviation, convergence, toolAccuracy, faithfulness, debtHealth } = data.scores;
    const dims = [
      { name: '偏差', key: 'deviation', score: deviation },
      { name: '收敛', key: 'convergence', score: convergence },
      { name: '工具准确', key: 'toolAccuracy', score: toolAccuracy },
      { name: '推理一致', key: 'faithfulness', score: faithfulness },
      { name: '债务健康', key: 'debtHealth', score: debtHealth },
    ];

    const low = dims.filter(d => d.score < 60).map(d => `${d.name}=${d.score}`);
    const high = dims.filter(d => d.score >= 85).map(d => `${d.name}=${d.score}`);

    const lines: string[] = [
      '[Quality Feedback]',
      `Previous session: qualityIndex=${data.lastQualityIndex}`,
    ];

    if (high.length > 0) lines.push(`  ✅ 好: ${high.join(', ')}`);
    if (low.length > 0) lines.push(`  ❌ 注意: ${low.join(', ')}`);
    if (low.length === 0 && high.length > 0) lines.push('  无短板 — 保持当前策略');

    return lines.join('\n');
  }

  // 回退：无 scores 时用 3 档模糊分（兼容旧数据）
  if (data.lastQualityIndex < 55) {
    return (
      '[Quality Feedback]\n' +
      `Previous session quality: LOW (${data.lastQualityIndex}/100).\n` +
      'MUST increase rigor:\n' +
      '  1. Verify every tool output before using it\n' +
      '  2. Prefer Read/Grep over inference\n' +
      '  3. Output "[InsufficientContext]" when unsure\n' +
      '  4. After 2+ tool errors, pause and reassess approach'
    );
  }

  if (data.lastQualityIndex < 70) {
    return (
      '[Quality Feedback]\n' +
      `Previous session quality: MODERATE (${data.lastQualityIndex}/100).\n` +
      'Suggestions:\n' +
      '  1. Double-check tool outputs before relying on them\n' +
      '  2. Use codegraph_explore for unknown structures\n' +
      `  3. Trend: ${data.trend}`
    );
  }

  if (data.lastQualityIndex >= 85 && data.trend !== 'declining') {
    return (
      '[Quality Feedback]\n' +
      `Previous session quality: HIGH (${data.lastQualityIndex}/100). Earned trust.\n` +
      'Maintaining current approach is sufficient — no additional rigor needed.'
    );
  }

  return null;
}
