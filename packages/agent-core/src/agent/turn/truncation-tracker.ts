/**
 * Phase24/24.2: 截断数据跟踪器。
 *
 * 跟踪哪些工具输出的 archive key 尚未通过 ArchiveRecover 回收。
 * 按 key 粒度管理——archive_recover(key-A) 只清除 key-A，不影响 key-B。
 * auto-prune 超过步阈值的条目防止 memory leak。
 *
 * 通过静态 current 引用解耦——ArchiveRecoverTool 无需依赖 TurnController。
 *
 * Phase24.1 增强：
 * - maxStepAge 和 maxConsecutiveBlocks 改为可配置构造参数
 * - 增加 forceResume() 强制恢复全部——连续拦截超过阈值时自动过渡
 * - dispose() 安全清理静态引用
 * - prune() 增加日志，可追踪老化淘汰
 *
 * Phase24.2 增强：
 * - readOnlyTools 可配置（取代硬编码 READ_ONLY_TOOLS）
 * - TruncationEntry 增加 originalLength / truncatedLength——支持截断比例感知
 * - 步级 recover 追踪——防止同一步内多个并行工具重复 recover 同一 key
 */

export interface TruncationEntry {
  readonly key: string;
  readonly toolName: string;
  readonly step: number;
  /** Phase24.2: 原始结果总长度（字节或字符数）。undefined 表示未知。 */
  readonly originalLength?: number;
  /** Phase24.2: 实际被截断后的长度。undefined 表示未知。 */
  readonly truncatedLength?: number;
}

export interface TruncationTrackerConfig {
  /** prune 步数阈值，默认 20 */
  maxStepAge?: number;
  /**
   * Phase24.1: 连续拦截次数上限。
   * 超过此值后自动 forceResume()，防止「拦截→失败→再拦截」死锁。
   * 默认 0 表示不启用（Phase24 兼容行为）。
   * Phase24.1 建议值 3。
   */
  maxConsecutiveBlocks?: number;
  /**
   * Phase24.2: 只读工具集合。这些工具不触发拦截/forceResume。
   * 可通过构造参数覆盖或扩展。默认 ['Bash']。
   */
  readOnlyTools?: Set<string>;
}

export class TruncationTracker {
  /** 全局当前 tracker 实例。TurnController 初始化时设置，turn 结束时清除。 */
  static current: TruncationTracker | undefined;

  private readonly entries = new Map<string, TruncationEntry>();
  private readonly maxStepAge: number;
  private readonly maxConsecutiveBlocks: number;
  private readonly readOnlyTools: Set<string>;

  /** 是否在本 turn 中提示过 AI */
  private _reminded = false;

  /**
   * Phase24.1: 连续拦截计数器。
   * 每次 guard 返回 syntheticError 时递增，forceResume() 或 recover 成功时归零。
   */
  private blockCount = 0;

  /**
   * Phase24.2: 步级 recover 追踪。
   * Map<step, Set<key>> —— 记录某一步中哪些 key 已被 recover。
   * 防止同一步内多个并行工具重复 recover 同一 key。
   */
  private stepRecovered = new Map<number, Set<string>>();

  get remindedThisTurn(): boolean {
    return this._reminded;
  }

  /** Phase24.1: 当前连续拦截次数。 */
  get consecutiveBlocks(): number {
    return this.blockCount;
  }

  constructor(config?: TruncationTrackerConfig) {
    this.maxStepAge = config?.maxStepAge ?? 20;
    this.maxConsecutiveBlocks = config?.maxConsecutiveBlocks ?? 0;
    this.readOnlyTools = config?.readOnlyTools ?? new Set<string>(['Bash']);
  }

  /**
   * Phase24.2: 判断某个工具是否为只读工具。
   * 只读工具不触发拦截和 forceResume。
   */
  isReadOnly(toolName: string): boolean {
    return this.readOnlyTools.has(toolName);
  }

  /**
   * 注册一个截断条目。
   * 如果同 key 已存在则不更新（先注册优先）。
   * Phase24.2: 可选记录原始长度和截断后长度。
   */
  register(
    key: string,
    toolName: string,
    step: number,
    originalLength?: number,
    truncatedLength?: number,
  ): void {
    if (!key || this.entries.has(key)) return;
    this.entries.set(key, {
      key,
      toolName,
      step,
      originalLength,
      truncatedLength,
    });
  }

  /**
   * 标记某个 key 已通过 archive_recover 回收。
   * 返回 true 表示该 key 确实是注册的截断 key。
   */
  markRecovered(key: string): boolean {
    if (!this.entries.has(key)) return false;
    this.entries.delete(key);
    // 恢复成功后归零连续拦截计数
    this.blockCount = 0;
    return true;
  }

  /**
   * Phase24.2: 标记某 key 在当前 step 已被 recover。
   * 防止同一步内多个并行工具重复 recover。
   * 返回 true 表示本次是首次 recover（允许执行），false 表示已 recover 过（跳过）。
   */
  markStepRecovered(key: string, step: number): boolean {
    if (!this.entries.has(key)) return false;
    // 检查该 step 是否已 recover 过此 key
    const stepKeys = this.stepRecovered.get(step);
    if (stepKeys?.has(key)) {
      return false; // 已 recover 过，跳过
    }
    // 记录
    if (!stepKeys) {
      this.stepRecovered.set(step, new Set([key]));
    } else {
      stepKeys.add(key);
    }
    return true;
  }

  /**
   * Phase24.2: 检查某 key 在当前 step 是否已被 recover。
   */
  isAlreadyRecoveredThisStep(key: string, step: number): boolean {
    return this.stepRecovered.get(step)?.has(key) ?? false;
  }

  /**
   * Phase24.2: 清理指定 step 的 recover 记录。
   * 在 step 切换或 afterStep 中调用。
   */
  clearStepRecovered(step: number): void {
    this.stepRecovered.delete(step);
  }

  /** 是否有未回收的截断？ */
  hasUnrecovered(): boolean {
    return this.entries.size > 0;
  }

  /** 返回所有未回收的 key。 */
  pendingKeys(): readonly string[] {
    return [...this.entries.keys()];
  }

  /** 返回所有未回收条目的只读快照。 */
  snapshot(): readonly TruncationEntry[] {
    return [...this.entries.values()];
  }

  /** 标记本 turn 已提醒过。 */
  markReminded(): void {
    this._reminded = true;
  }

  /**
   * Phase24.1: 递增连续拦截计数。
   * 如果达到 maxConsecutiveBlocks 上限则自动 forceResume。
   * 返回 true 表示已自动触发 forceResume。
   */
  incrementBlockAndCheck(): boolean {
    this.blockCount++;
    if (this.maxConsecutiveBlocks > 0 && this.blockCount >= this.maxConsecutiveBlocks) {
      this.forceResume('auto-resume after max consecutive blocks');
      return true;
    }
    return false;
  }

  /**
   * Phase24.1: 强制恢复全部——标记所有 pending key 为已恢复。
   * 用于「拦截死锁」熔断——连续拦截 maxConsecutiveBlocks 次后自动调用，
   * 也可由 afterStep 在检测到死锁时主动调用。
   *
   * @param reason 触发原因，仅用于日志
   */
  forceResume(reason?: string): void {
    this.entries.clear();
    this._reminded = false;
    this.blockCount = 0;
    this.stepRecovered.clear();
    if (reason) {
      // eslint-disable-next-line no-console
      console.debug(`[TruncationTracker] forceResume: ${reason}`);
    }
  }

  /**
   * Phase24.1: 安全清理静态引用。
   * 在 turn 清理完毕后调用，确保不会泄漏到下一轮。
   */
  dispose(): void {
    this.entries.clear();
    this._reminded = false;
    this.blockCount = 0;
    this.stepRecovered.clear();
    if (TruncationTracker.current === this) {
      TruncationTracker.current = undefined;
    }
  }

  /**
   * 清除超出步数阈值的条目，防止 memory leak。
   * 通常在每轮 afterStep 末尾调用。
   * Phase24.1: 使用构造参数 maxStepAge，prune 时打日志。
   * Phase24.2: 一并清理过期的 stepRecovered 记录。
   */
  prune(currentStep: number, maxStepAgeOverride?: number): void {
    const age = maxStepAgeOverride ?? this.maxStepAge;
    const cutoff = currentStep - age;
    let prunedCount = 0;
    for (const [key, entry] of this.entries) {
      if (entry.step <= cutoff) {
        this.entries.delete(key);
        prunedCount++;
      }
    }
    // 清理过期的 stepRecovered 记录
    for (const [step] of this.stepRecovered) {
      if (step <= cutoff) {
        this.stepRecovered.delete(step);
      }
    }
    if (prunedCount > 0) {
      // eslint-disable-next-line no-console
      console.debug(`[TruncationTracker] prune: removed ${prunedCount} stale entries at step ${currentStep}`);
    }
    if (this.entries.size === 0) {
      this._reminded = false;
    }
  }

  /** Turn 结束时清理全部。 */
  clear(): void {
    this.entries.clear();
    this._reminded = false;
    this.blockCount = 0;
    this.stepRecovered.clear();
  }
}
