/**
 * ErrorAuditInjector — FAA 再生（2-Pillar 消费者终审版）
 *
 * 废弃旧功能"马后炮罗列失败"（与 guard/偏差链重叠），
 * 改为双支柱注入 FAA 全量操作记录中的趋势信号：
 *
 *   支柱一（P0）：超时死循环+耗时膨胀
 *     - 连续≥2次 Bash 超时 → FATAL|TIMEOUT
 *     - 最新工具耗时 > 滚动均值×1.5 → WARN|INFLATE
 *
 * 注入格式：AI 原生 3 行定长（AI 50ms 解析）
 *   PREFIX|CAT|key=value
 *   ROOT|cause
 *   ACT|opt1|opt2|opt3
 *
 * 注册 variant: 'error-audit'
 */

import { DynamicInjector, type ResidualConfig } from './injector';
import { InsertPosition } from './position-strategy';
import type { Agent } from '..';
import type { FileActionAuditEntry } from '../audit/file-action-audit';

export class ErrorAuditInjector extends DynamicInjector {
  protected readonly injectionVariant = 'error-audit';

  constructor(agent: Agent) {
    super(agent);
  }

  /** 注入到上下文中间位置（靠近尾部，不干扰决策） */
  override getTargetPosition(): InsertPosition {
    return InsertPosition.MID_CONTEXT;
  }

  /** 残差控制：降低每轮注入频率 */
  override getResidualConfig(): ResidualConfig | undefined {
    return { weight: 0.5, decayPerStep: 0.85, minStepGap: 4, threshold: 0.2 };
  }

  protected getInjection(): string | undefined {
    // 非交互终端（TERM=dumb）下不注入 — Git Bash 超时是环境问题而非 AI 策略问题
    if (process.env['TERM'] === 'dumb') return undefined;

    const audit = (this.agent as any).fileActionAudit as
      | { getRecentEntries: (n: number) => FileActionAuditEntry[] }
      | undefined;
    if (!audit) return undefined;

    const entries = audit.getRecentEntries(10);
    if (entries.length < 2) return undefined;

    const blocks: string[] = [];

    // ── 支柱一：超时死循环（连续≥2次 Bash 超时）──
    const timeoutResult = this.detectConsecutiveTimeouts(entries);
    if (timeoutResult) blocks.push(timeoutResult);

    // ── 支柱一：耗时膨胀（latest > avg×1.5），仅超时未命中时检查 ──
    if (!timeoutResult) {
      const inflateResult = this.detectDurationInflation(entries);
      if (inflateResult) blocks.push(inflateResult);
    }

    if (blocks.length === 0) return undefined;

    const injection = blocks.join('\n');

    // 记录事实供 [Context Facts] 聚合
    const facts: string[] = [];
    if (timeoutResult) facts.push('检测到连续超时');
    if (!timeoutResult && blocks.some((b) => b.startsWith('WARN|INFLATE')))
      facts.push('检测到耗时膨胀');
    this.agent.context.recordFact?.('error-audit', facts.join('；'), 'error');

    return injection;
  }

  /**
   * 连续超时检测 — 在 entries 流中找连续 2+ 条 Bash 超时
   *
   * 超时判别：Bash 失败 + durationMs > TIMEOUT_MS_THRESHOLD
   *   ≥30000ms -> 超时（工具报错通常在 <5s 内返回）
   * 非超时 / 成功 → 重置计数器，确保真正连续
   */
  private readonly TIMEOUT_MS_THRESHOLD = 30_000;

  private detectConsecutiveTimeouts(
    entries: FileActionAuditEntry[],
  ): string | null {
    let consecutive = 0;
    for (const e of entries) {
      const isTimeout =
        e.action.startsWith('Bash') &&
        !e.success &&
        e.durationMs > this.TIMEOUT_MS_THRESHOLD;
      if (isTimeout) {
        consecutive++;
        if (consecutive >= 2) {
          return [
            `FATAL|TIMEOUT|action=Bash consecutive=${consecutive} max=${e.durationMs}ms`,
            'ROOT|连续超时可能导致死循环',
            'ACT|中断当前策略|检查阻塞条件|改用更直接的工具链',
          ].join('\n');
        }
      } else {
        consecutive = 0;
      }
    }
    return null;
  }

  /**
   * 耗时膨胀检测 — 同工具类型内最新耗时 > 滚动均值×1.5
   *
   * 只对比相同 action 的条目，避免跨工具误报
   * （如 Bash 构建耗时 > Read 均值不触发）
   * 仅在同类型 ≥3 条有效数据时启用
   */
  private detectDurationInflation(
    entries: FileActionAuditEntry[],
  ): string | null {
    const latest = entries[0];
    if (!latest || !latest.durationMs || latest.durationMs <= 0) return null;

    const sameTool = entries.filter(
      (e) => e.action === latest.action && e.success && e.durationMs > 0,
    );
    if (sameTool.length < 3) return null;

    const avg =
      sameTool.reduce((s, e) => s + e.durationMs, 0) / sameTool.length;

    if (latest.durationMs > avg * 1.5) {
      const ratio = (latest.durationMs / avg).toFixed(1);
      return [
        `WARN|INFLATE|tool=${latest.action} ratio=${ratio} avg=${Math.round(avg)}ms cur=${latest.durationMs}ms`,
        'ROOT|工具耗时异常膨胀',
        'ACT|避免逐行编辑|考虑一次性重写|检查是否陷入局部优化',
      ].join('\n');
    }
    return null;
  }

}
