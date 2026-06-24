/**
 * VariantRegistry — 回合级注入变体元数据注册表。
 *
 * 纯数据层。记录本回合每个注入变体的权重等级、注入时机和行为观察状态。
 * 不依赖任何检测器或注入器。谁都能读。
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
  /** 🆕 Phase15+: 行为观察回调（用于 event log 记录 behavior_feedback） */
  onBehaviorObserved?: (variant: string, observed: boolean) => void;

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
      this.onBehaviorObserved?.(variant, true);
    }
  }

  /**
   * 标记某变体的行为未观察（已检查但不存在）。
   */
  markBehaviorNotObserved(variant: string): void {
    const record = this.records.get(variant);
    if (record && record.behaviorObserved === null) {
      record.behaviorObserved = false;
      this.onBehaviorObserved?.(variant, false);
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

// ── ResNet 残差注意力模型 (Phase 9) ─────────────────────────

/**
 * 每个 variant 的残差注意力配置。
 *
 * R = W × D^Δs
 * R < threshold → 注意力不足 → 需要注入
 * R >= threshold → 注意力还够 → 跳过
 */
export interface VariantMeta {
  /** 静态权重 (0-1)，越高越重要 */
  weight: number;
  /** 每步衰减系数 (0.8-0.99)，越高衰减越慢 */
  decayPerStep: number;
  /** 触发阈值 (0-1)，低于此值触发注入 */
  threshold: number;
  /** 最小步间隔，防止高频重复 */
  minStepGap: number;
  /** 🆕 Phase15: S→S 拦截阈值。0=从不拦截，N=连续 S→S N 次后进入偏差链 */
  interceptThreshold?: number;
}

export const VARIANT_META: Record<string, VariantMeta> = {
  // system_trigger / 紧急 → 永不跳过（死代码保留行，万一 inject() 前移逻辑需要；当前 system_trigger 在 inject() 顶部提前返回）
  system_trigger:              { weight: 1.0, decayPerStep: 0.99, threshold: 0.1, minStepGap: 0 },
  deviation_chain_intercept:   { weight: 1.0, decayPerStep: 0.99, threshold: 0.1, minStepGap: 0 },

  // intent — 回合开始时注入，不跨步衰减
  intent_fix_bug:              { weight: 0.9, decayPerStep: 0.92, threshold: 0.3, minStepGap: 0 },
  intent_refactor:             { weight: 0.9, decayPerStep: 0.92, threshold: 0.3, minStepGap: 0 },
  intent_add_feature:          { weight: 0.9, decayPerStep: 0.92, threshold: 0.3, minStepGap: 0 },
  intent_review:               { weight: 0.8, decayPerStep: 0.90, threshold: 0.3, minStepGap: 0 },
  intent_research:             { weight: 0.8, decayPerStep: 0.90, threshold: 0.3, minStepGap: 0 },
  intent_document:             { weight: 0.7, decayPerStep: 0.88, threshold: 0.3, minStepGap: 0 },

  // A组: prepare — 工具执行前提醒
  prepare_edit:                { weight: 0.8, decayPerStep: 0.85, threshold: 0.35, minStepGap: 4 },
  prepare_write:               { weight: 0.8, decayPerStep: 0.85, threshold: 0.35, minStepGap: 4 },
  prepare_search:              { weight: 0.7, decayPerStep: 0.85, threshold: 0.40, minStepGap: 3 },
  prepare_memory:              { weight: 0.7, decayPerStep: 0.85, threshold: 0.40, minStepGap: 3 },
  prepare_bash_file:           { weight: 0.5, decayPerStep: 0.82, threshold: 0.40, minStepGap: 3 },
  prepare_verify:              { weight: 0.8, decayPerStep: 0.85, threshold: 0.35, minStepGap: 4 },

  // B组: post — 工具执行后反馈
  post_edit:                   { weight: 0.6, decayPerStep: 0.80, threshold: 0.40, minStepGap: 4 },
  post_search:                 { weight: 0.6, decayPerStep: 0.80, threshold: 0.40, minStepGap: 4 },
  post_write_large:            { weight: 0.5, decayPerStep: 0.80, threshold: 0.40, minStepGap: 4 },
  post_verify_pass:            { weight: 0.5, decayPerStep: 0.80, threshold: 0.40, minStepGap: 4 },
  post_verify_fail:            { weight: 0.9, decayPerStep: 0.88, threshold: 0.40, minStepGap: 3 },
  post_memory:                 { weight: 0.6, decayPerStep: 0.80, threshold: 0.40, minStepGap: 4 },

  // C组: step_after — 步级行为反馈
  step_after_edit:             { weight: 0.6, decayPerStep: 0.80, threshold: 0.40, minStepGap: 5, interceptThreshold: 3 },
  step_after_search:           { weight: 0.5, decayPerStep: 0.80, threshold: 0.40, minStepGap: 5 },
  step_after_verify_fail:      { weight: 0.8, decayPerStep: 0.85, threshold: 0.40, minStepGap: 4, interceptThreshold: 3 },

  // ── Phase 12: 反馈信号闭环 variants ────────────────────────────
  // Rule 1 (阻断) 不走 inject() 路径，无需 VARIANT_META
  guard_feedback_rule_2:      { weight: 0.7, decayPerStep: 0.85, threshold: 0.35, minStepGap: 4, interceptThreshold: 3 },
  guard_feedback_rule_3:      { weight: 0.8, decayPerStep: 0.85, threshold: 0.35, minStepGap: 4, interceptThreshold: 2 },
  feedback_positive:          { weight: 0.6, decayPerStep: 0.80, threshold: 0.40, minStepGap: 5 },

  // ── Phase 13: 行为闭环与展示规范 ──────────────────────────────
  guard_feedback_rule_4:     { weight: 0.7, decayPerStep: 0.85, threshold: 0.35, minStepGap: 4, interceptThreshold: 3 },
  scene_memory_recall:       { weight: 0.8, decayPerStep: 0.88, threshold: 0.30, minStepGap: 5, interceptThreshold: 3 },
  step_code_ref_quality:     { weight: 0.5, decayPerStep: 0.85, threshold: 0.40, minStepGap: 6 },
};

/**
 * ResNet 残差注意力决策。
 * 根据 variant 的剩余注意力水平决定是否需要注入。
 *
 * 首次注入始终允许（无 record）。后续注入按残差公式判断。
 *
 * @returns true = 需要注入, false = 注意力还够，跳过
 */
export function shouldInjectByResidual(
  record: VariantRecord | undefined,
  currentStep: number,
  meta: VariantMeta,
): boolean {
  if (!record) return true;
  const stepDelta = currentStep - record.stepInjected;
  if (stepDelta < meta.minStepGap) return false;
  const residual = meta.weight * Math.pow(meta.decayPerStep, stepDelta);
  return residual < meta.threshold;
}

/**
 * 根据残差值决定是否使用短文本。
 *
 * residual > threshold × 0.5 → 短文本（刚过阈值，轻度提醒即可）
 * residual <= threshold × 0.5 → 长文本（远低于阈值，需要完整提醒）
 */
export function shouldUseShortText(
  record: VariantRecord | undefined,
  currentStep: number,
  meta: VariantMeta,
): boolean {
  if (!record) return false;
  const stepDelta = currentStep - record.stepInjected;
  const residual = meta.weight * Math.pow(meta.decayPerStep, stepDelta);
  return residual > meta.threshold * 0.5;
}

/**
 * 缩短注入文本：保留核心祈使句，去掉论证和语气词。
 * 用于注意力衰减刚过阈值时的轻度提醒。
 */
export function shortenText(text: string): string {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  // 优先取 MUST/NEVER/ALWAYS 祈使句
  const imperative = lines.find(l => /\b(MUST|NEVER|ALWAYS)\b/.test(l));
  if (imperative) return imperative;
  // 回退到第一条非空行
  return lines[0] ?? text;
}
