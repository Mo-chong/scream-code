/**
 * VariantRegistry — 回合级注入变体元数据注册表。
 *
 * 纯数据层。记录本回合每个注入变体的权重等级、注入时机和行为观察状态。
 * 不依赖任何检测器或注入器。谁都能读。
 *
 * ## ResNet mapping
 *
 * | 概念        | VariantRegistry                  |
 * |-------------|----------------------------------|
 * | Shortcut    | behaviorObserved === true 直通   |
 * | Residual    | 注入后无对应行为 → 需要升级     |
 */

export type WeightLevel = 'S' | 'A' | 'B' | 'C' | 'D';

export interface VariantRecord {
  /** 变体名称，如 'step_after_edit', 'prepare_verify' */
  variant: string;
  /** 注入时的权重等级 */
  level: WeightLevel;
  /** 在本回合第几步注入的（1-based） */
  stepInjected: number;
  /** 全局步号 */
  turnStep: number;
  /**
   * 后续步中模型是否出现了该变体约束的目标行为。
   * null = 尚未检查
   * true = 已观察
   * false = 已检查但未观察
   */
  behaviorObserved: boolean | null;
  /** 上一次升级时的回合步号（0 = 从未升级） */
  lastEscalatedAtStep: number;
  /** 本回合该变体被触发的总次数（含第一次）。跨步累加。 */
  triggerCount: number;
}

export class VariantRegistry {
  private records = new Map<string, VariantRecord>();

  /**
   * 记录一个注入变体。同变体在同回合只记录第一次，
   * 但 triggerCount 跨步累加，stepInjected 更新为最近一次触发步号。
   * stepInjected 被 detectQualityIssue 用于判断变体是否过期，
   * 因此需要随触发更新（否则旧变体的衰老时钟不会重置）。
   */
  record(variant: string, level: WeightLevel, step: number): void {
    const existing = this.records.get(variant);
    if (existing) {
      existing.triggerCount++;
      existing.stepInjected = step;
      return;
    }
    this.records.set(variant, {
      variant,
      level,
      stepInjected: step,
      turnStep: step,
      behaviorObserved: null,
      lastEscalatedAtStep: 0,
      triggerCount: 1,
    });
  }

  /**
   * 获取指定变体的记录。
   */
  get(variant: string): VariantRecord | undefined {
    return this.records.get(variant);
  }

  /**
   * 获取所有变体记录。
   */
  getAll(): VariantRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * 获取已过期的变体（注入超过 N 步仍未观察到行为）。
   */
  getStale(currentStep: number, maxAge: number): VariantRecord[] {
    const result: VariantRecord[] = [];
    for (const record of this.records.values()) {
      if (
        record.behaviorObserved !== true &&
        currentStep - record.stepInjected >= maxAge
      ) {
        result.push(record);
      }
    }
    return result;
  }

  /**
   * 标记某变体的行为已被观察。
   */
  markBehaviorObserved(variant: string): void {
    const record = this.records.get(variant);
    if (record) {
      record.behaviorObserved = true;
    }
  }

  /**
   * 标记某变体的行为未观察（已检查但不存在）。
   */
  markBehaviorNotObserved(variant: string): void {
    const record = this.records.get(variant);
    if (record && record.behaviorObserved === null) {
      record.behaviorObserved = false;
    }
  }

  /**
   * 记录某变体已被升级。
   */
  markEscalated(variant: string, step: number): void {
    const record = this.records.get(variant);
    if (record) {
      record.lastEscalatedAtStep = step;
    }
  }

  /**
   * 获取自上次升级后经过的步数。
   */
  stepsSinceLastEscalation(variant: string, currentStep: number): number {
    const record = this.records.get(variant);
    if (!record || record.lastEscalatedAtStep === 0) return -1;
    return currentStep - record.lastEscalatedAtStep;
  }

  /**
   * 更新变体的权重等级和升级时间（原地更新，不创建新记录）。
   * 用于升级链：C→B→A→S 渐进升级时改写原始变体的权重。
   */
  updateLevel(variant: string, newLevel: WeightLevel, step: number): void {
    const record = this.records.get(variant);
    if (record) {
      record.level = newLevel;
      record.lastEscalatedAtStep = step;
    }
  }

  /**
   * 回合开始时清空注册表。
   */
  reset(): void {
    this.records.clear();
  }

  /** 当前记录的变体数量。 */
  get size(): number {
    return this.records.size;
  }

  /**
   * 检查注册表中是否含有意图变体（intent_ 前缀）。
   * 用于 observeBehavior 快速判断是否需要执行意图行为观察。
   */
  hasIntentVariants(): boolean {
    for (const key of this.records.keys()) {
      if (key.startsWith('intent_')) return true;
    }
    return false;
  }
}

// ── 权重等级检测（纯函数，100% 文本模式匹配）────────────────

/**
 * 根据注入文本判断其所属的权重等级。
 *
 * 基于指令权重金字塔：
 * - S: 结构锚定（<system-reminder> 包裹，<|im_start|>）
 * - A: 祈使（MUST/NEVER/ALWAYS/REQUIRED）
 * - B: 结构化（步骤编号、条件格式 "If...then"）
 * - C: 否定（DO NOT/不要/Never/不得）
 * - D: 角色/其他
 *
 * 纯函数。不涉及 NL 理解。
 */
export function detectWeightLevel(text: string): WeightLevel {
  if (
    text.startsWith('<system-reminder') ||
    text.includes('<|im_start|>')
  ) {
    return 'S';
  }
  if (/\b(MUST|NEVER|ALWAYS|REQUIRED)\b/.test(text)) {
    return 'A';
  }
  if (
    /^Step \d|^\d+\.|^-\s|^In one sentence/.test(text) ||
    /\bIf\s+.+\bthen\b/i.test(text)
  ) {
    return 'B';
  }
  if (/\b(DO NOT|不要|Never|不得)\b/i.test(text)) {
    return 'C';
  }
  return 'D';
}

/**
 * 权重提升一级（C→B→A→S）。
 * S 是最高级，不再提升。
 */
export function escalateLevel(level: WeightLevel): WeightLevel {
  switch (level) {
    case 'C': return 'B';
    case 'D': return 'B';
    case 'B': return 'A';
    case 'A': return 'S';
    case 'S': return 'S';
  }
}

// ── 重复衰减（Phase 6）──────────────────────────────────────

export type RepeatAction = 'full' | 'skip';

/**
 * 同变体重复触发衰减决策。
 *
 * 注入文本的边际价值随同场景重复次数递减：
 * - 首次或 behaviorObserved → full（不衰减）
 * - 跨步累计触发 5+ 次 → skip（静默跳过）
 *
 * 纯函数。不返回 'short'——需要不同缩短文本的变体太多，
 * 当前收益不足以覆盖每个变体配两版文本的成本。
 */
export function repeatDecay(record: VariantRecord | undefined): RepeatAction {
  if (!record) return 'full';
  if (record.behaviorObserved === true) return 'full';
  if (record.triggerCount >= 5) return 'skip';
  return 'full';
}
