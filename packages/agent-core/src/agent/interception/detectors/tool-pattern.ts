/**
 * ToolPattern Detector
 *
 * 检测不高效的工貝使用模式：
 *   1. 连续 Read/Grep ≥3 次且未调用 codegraph_explore → 建议用 codegraph
 *   2. 连续同一工具报错 ≥2 次 → 建议换方法
 *
 * 纯函数 — 只检测，不输出。
 * 替代系统 prompt 中"连续 5 次 Read 必须调 codegraph"的硬计数规则。
 * 区别：本 detector 用条件判断（连续 Read 没找到目标时才提示），不是死数字。
 */

import type { DetectorFn, RawSignal } from '../types';

export const toolPatternDetector: DetectorFn = (ctx): RawSignal | null => {
  const tools = ctx.lastToolCalls;
  if (!tools || tools.length < 3) return null;

  // 检查最近几次工具调用
  const recent = tools.slice(-5);
  let readCount = 0;
  let grepCount = 0;
  let codegraphCount = 0;
  let errorCount = 0;
  let lastToolName = '';
  let consecutiveSameError = 0;

  for (const t of recent) {
    const tc = t as any;
    const name = tc?.name ?? '';
    const isError = tc?.result?.isError === true;

    if (name === 'Read' || name === 'ReadMediaFile') readCount++;
    else if (name === 'Grep' || name === 'Glob') grepCount++;
    else if (name === 'mcp__codegraph__codegraph_explore' || name === 'codegraph_explore' || name?.includes('codegraph')) codegraphCount++;
    else readCount = 0; // 非 Read 操作中断计数

    if (isError && name === lastToolName) consecutiveSameError++;
    else if (isError) consecutiveSameError = 1;
    else if (!isError) consecutiveSameError = 0;

    lastToolName = isError ? name : '';
  }

  // 条件1：连续 Read/Grep ≥3 次且没调 codegraph（替代系统 prompt 的硬性 5 次）
  if (readCount + grepCount >= 3 && codegraphCount === 0) {
    return {
      rootCause: 'quality_degrade',
      priority: 'normal',
      confidence: 0.6,
      message: '检测到连续 Read/Grep 探索。如果找不到目标文件或结构，试试用 codegraph_explore 查符号关联和调用路径——它比手动 Read 更高效。大面积未知探索用 maxFiles=12，已知模块探细节用 maxFiles=3 可省 80% token。已知道符号名时 node/callees 更精准。',
      escalation: 'hint',
      phase: 'post_step',
    };
  }

  // 条件2：连续同一工具报错 ≥2 次
  if (consecutiveSameError >= 2) {
    return {
      rootCause: 'quality_degrade',
      priority: 'normal',
      confidence: 0.7,
      message: `连续 ${consecutiveSameError + 1} 次调用同一工具报错：${lastToolName}。建议检查参数或换其他方法。`,
      escalation: 'hint',
      phase: 'post_step',
    };
  }

  return null;
};
