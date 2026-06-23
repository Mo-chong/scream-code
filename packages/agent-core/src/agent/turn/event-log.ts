/**
 * TurnEventLog — 回合级拦截事件日志系统。
 *
 * 内存环形缓冲区。记录系统在 inject() / convergence gate / afterStep 中
 * 发生的所有拦截事件。AI 没有绕过权——record() 调用嵌入在硬编码路径中。
 *
 * 与 SessionMemory 同模式：环形缓冲区 + record() + getTurnSummary()。
 * SessionMemory 记工具执行，TurnEventLog 记拦截事件。
 */

export interface InterceptionEvent {
  /** 全局序列号。单调递增。 */
  seq: number;
  /** 事件种类：injection_skipped | injection_delivered | convergence_gate | deviation_chain | confabulation | verify_fail */
  kind: string;
  /** 相关 variant 名称（无 variant 的穿件传空字符串） */
  variant: string;
  /** 记录时的回合步号 */
  step: number;
  /** 具体动作：skipped_residual | skipped_budget | injected | gate_held | gate_passed | detected */
  action: string;
  /** 人类可读的原因说明 */
  reason: string;
  /** 所属回合 ID */
  turnId: number;
}

const MAX_EVENTS = 200;

export class TurnEventLog {
  private events: InterceptionEvent[] = [];
  private nextSeq = 1;

  /** 增量摘要追踪：用于 afterStep 只注入新事件。 */
  private lastSummarizedTurnId = -1;
  private lastSummarizedSeq = 0;

  /**
   * 记录一条拦截事件。
   * seq 自动分配。事件数超 MAX_EVENTS 时丢弃最旧的事件。
   */
  record(event: Omit<InterceptionEvent, 'seq'>): void {
    this.events.push({ ...event, seq: this.nextSeq++ });
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }

  /** 获取指定回合的所有事件。 */
  getTurnEvents(turnId: number): InterceptionEvent[] {
    return this.events.filter(e => e.turnId === turnId);
  }

  /** 按事件种类过滤。 */
  getByKind(kind: string): InterceptionEvent[] {
    return this.events.filter(e => e.kind === kind);
  }

  /** 按 variant 名称过滤。 */
  getByVariant(variant: string): InterceptionEvent[] {
    return this.events.filter(e => e.variant === variant);
  }

  /**
   * 获取自上次调用以来新增的回合事件摘要。
   * 用于 afterStep 增量注入——避免重复发送已报告的事件。
   * 跨回合自动重置。
   *
   * 自动过滤掉 interception_log 变体自身的事件，防止日志注入自引用的无限循环。
   */
  getNewTurnSummary(turnId: number): string {
    if (turnId !== this.lastSummarizedTurnId) {
      this.lastSummarizedTurnId = turnId;
      this.lastSummarizedSeq = 0;
    }
    const newEvents = this.events.filter(e =>
      e.seq > this.lastSummarizedSeq && e.turnId === turnId && e.variant !== 'interception_log',
    );
    if (newEvents.length === 0) return '';

    this.lastSummarizedSeq = this.events.at(-1)?.seq ?? 0;
    return this.formatEvents(newEvents);
  }

  /** 回合开始时清空。 */
  clear(): void {
    this.events.length = 0;
    this.nextSeq = 1;
    this.lastSummarizedTurnId = -1;
    this.lastSummarizedSeq = 0;
  }

  /** 将事件列表格式化为摘要文本。 */
  private formatEvents(events: InterceptionEvent[]): string {
    const lines: string[] = ['### 拦截日志', ''];
    const groups = new Map<string, InterceptionEvent[]>();

    for (const e of events) {
      const key = `${e.kind}/${e.action}`;
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(e);
    }

    for (const [key, group] of groups) {
      lines.push(`- ${key}: ${group.length} 次`);
      for (const e of group.slice(-3)) {
        const v = e.variant ? `[${e.variant}] ` : '';
        lines.push(`  · 第${e.step}步: ${v}${e.reason}`);
      }
    }

    return lines.join('\n');
  }
}
