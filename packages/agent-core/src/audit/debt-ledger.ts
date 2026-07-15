/**
 * DebtLedger — 分类债务账本
 *
 * 解决"一锅烩"问题：不同错误类型分开记债，分引导、分阻断。
 * 每类债有偿还机制——正确行为减债，错误行为加债。
 *
 * 设计原则：
 *   - 分类记：每类错误有自己的账本
 *   - 分类还：正确行为偿还对应分类
 *   - 分类导：触发哪类债就引导解决哪类问题
 *   - 阻断安全网：单类超限只阻断该类，总数超限才全阻断
 */

export type DebtCategory = 'exploration' | 'tool_error' | 'reasoning' | 'gate';

const ALL_CATEGORIES: DebtCategory[] = ['exploration', 'tool_error', 'reasoning', 'gate'];

/** 每类债务的阈值 */
const THRESHOLDS = {
  warning: 4.0,
  critical: 8.0,
  block: 12.0,
  hardBlock: 25.0, // 总债务安全网
};

/** 偿还速率 */
const REPAYMENT = {
  perCorrectCall: 0.05,   // 每次正确调用
  streakBonus: 0.3,       // 连续3次正确奖励
  convergenceResolve: 0.5, // 收敛门修正成功
};

export interface DebtLedgerData {
  categories: Record<DebtCategory, number>;
  total: number;
  streak: Record<DebtCategory, number>;  // 连续正确次数
  carryover: number;  // 跨回合保留值
}

export interface CategoryGuidance {
  message: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  blockToolPattern?: RegExp;  // 该分类达阻断阈值时，限制哪些工具
  fixSuggestion: string;
}

export class DebtLedger {
  private data: DebtLedgerData;

  constructor(carryover: number = 0) {
    this.data = {
      categories: { exploration: 0, tool_error: 0, reasoning: 0, gate: 0 },
      total: carryover,
      streak: { exploration: 0, tool_error: 0, reasoning: 0, gate: 0 },
      carryover,
    };
  }

  get total(): number { return this.data.total; }
  get categoryTotals(): Readonly<Record<DebtCategory, number>> { return this.data.categories; }

  /** 加债（按分类）*/
  addDebt(category: DebtCategory, reason: string, amount: number = 0.5): CategoryGuidance | null {
    this.data.categories[category] = Math.min(20, this.data.categories[category] + amount);
    this.recalcTotal();
    this.data.streak[category] = 0; // 重置连胜

    return this.getGuidance(category);
  }

  /** 还债（正确行为）*/
  repay(category: DebtCategory, amount: number): void {
    this.data.categories[category] = Math.max(0, this.data.categories[category] - amount);
    this.data.streak[category] += 1;

    // 连续3次正确 → 额外奖励
    if (this.data.streak[category] >= 3) {
      this.data.categories[category] = Math.max(0, this.data.categories[category] - REPAYMENT.streakBonus);
      this.data.streak[category] = 0;
    }
    this.recalcTotal();
  }

  /** 全局偿还（每次正确工具调用）*/
  repayAll(): void {
    for (const cat of ALL_CATEGORIES) {
      this.data.categories[cat] = Math.max(0, this.data.categories[cat] - REPAYMENT.perCorrectCall);
    }
    this.recalcTotal();
  }

  /** 收敛门解决 */
  repayGate(): void {
    this.data.categories.gate = Math.max(0, this.data.categories.gate - REPAYMENT.convergenceResolve);
    this.data.streak.gate += 1;
    this.recalcTotal();
  }

  /** 获取当前阻断信息：null = 无阻断，非 null = 哪些分类阻断 */
  getBlockedCategories(): Map<DebtCategory, CategoryGuidance> | null {
    const blocked = new Map<DebtCategory, CategoryGuidance>();

    // 安全网：总债务超限 → 全阻断
    if (this.data.total >= THRESHOLDS.hardBlock) {
      for (const cat of ALL_CATEGORIES) {
        blocked.set(cat, {
          message: `总债务 ${this.data.total.toFixed(1)} 已达安全网上限 ${THRESHOLDS.hardBlock}，所有工具阻断。请重新评估策略。`,
          severity: 'CRITICAL',
          fixSuggestion: '报告用户当前策略失效，请求人工介入。',
        });
      }
      return blocked;
    }

    // 单类阻断
    for (const cat of ALL_CATEGORIES) {
      const val = this.data.categories[cat];
      if (val >= THRESHOLDS.block) {
        blocked.set(cat, this.getGuidance(cat));
      }
    }

    return blocked.size > 0 ? blocked : null;
  }

  /** 检查是否应该阻断某工具 */
  shouldBlockTool(toolName: string): CategoryGuidance | null {
    for (const cat of ALL_CATEGORIES) {
      if (this.data.categories[cat] >= THRESHOLDS.block) {
        const guidance = this.getGuidance(cat);
        if (guidance.blockToolPattern?.test(toolName)) {
          return guidance;
        }
      }
    }
    // 安全网
    if (this.data.total >= THRESHOLDS.hardBlock) {
      return {
        message: `总债务 ${this.data.total.toFixed(1)} 已达安全网上限。`,
        severity: 'CRITICAL',
        fixSuggestion: '报告用户当前策略失效。',
      };
    }
    return null;
  }

  get carryover(): number { return this.data.carryover; }

  private recalcTotal(): void {
    this.data.total = 0;
    for (const cat of ALL_CATEGORIES) {
      this.data.total += this.data.categories[cat];
    }
  }

  private getGuidance(category: DebtCategory): CategoryGuidance {
    const val = this.data.categories[category];
    const severity: 'INFO' | 'WARNING' | 'CRITICAL' =
      val >= THRESHOLDS.critical ? 'CRITICAL' :
      val >= THRESHOLDS.warning ? 'WARNING' : 'INFO';

    return CATEGORY_GUIDANCE[category](val, severity);
  }
}

/** 工具名 → 债务分类映射 */
const TOOL_CATEGORY_MAP: Record<string, DebtCategory> = {
  Read: 'exploration',
  Grep: 'exploration',
  Glob: 'exploration',
  codegraph_node: 'exploration',
  codegraph: 'exploration',
  Edit: 'tool_error',
  Write: 'tool_error',
  Bash: 'tool_error',
  WebSearch: 'exploration',
};

export function toolToCategory(toolName: string): DebtCategory {
  return TOOL_CATEGORY_MAP[toolName] ?? 'exploration';
}

const CATEGORY_GUIDANCE: Record<DebtCategory, (val: number, severity: string) => CategoryGuidance> = {
  exploration: (val, severity) => ({
    message: severity === 'CRITICAL'
      ? `[Debt Monitor] [${severity}] 探索债务 ${val.toFixed(1)}。连续低效探索将阻断 Read/Grep。建议用 codegraph_explore（大面积未知用 maxFiles=12，已知模块用 maxFiles=3）。`
      : `[Debt Monitor] [${severity}] 探索债务 ${val.toFixed(1)}。试试用 codegraph_explore 替代 Read/Grep。`,
    severity: severity as any,
    blockToolPattern: /^(Read|Grep|Glob|WebSearch)$/,
    fixSuggestion: '用 codegraph_explore 替代直接 Read/Grep',
  }),
  tool_error: (val, severity) => ({
    message: severity === 'CRITICAL'
      ? `[Debt Monitor] [${severity}] 工具错误债务 ${val.toFixed(1)}。连续工具报错将阻断 Edit/Write。请检查输出格式是否合规。`
      : `[Debt Monitor] [${severity}] 工具错误债务 ${val.toFixed(1)}。检查格式约束后再调用。`,
    severity: severity as any,
    blockToolPattern: /^(Edit|Write)$/,
    fixSuggestion: '检查工具输出格式（参考 output-constraint.ts 约束）',
  }),
  reasoning: (val, severity) => ({
    message: severity === 'CRITICAL'
      ? `[Debt Monitor] [${severity}] 推理不一致债务 ${val.toFixed(1)}。推理与实际工具调用不匹配，请确认意图后再操作。`
      : `[Debt Monitor] [${severity}] 推理债务 ${val.toFixed(1)}。注意推理描述应与工具调用一致。`,
    severity: severity as any,
    blockToolPattern: undefined,
    fixSuggestion: '推理文本与实际工具调用对齐',
  }),
  gate: (val, severity) => ({
    message: severity === 'CRITICAL'
      ? `[Debt Monitor] [${severity}] 拦截债务 ${val.toFixed(1)}。多次触发收敛门，需全面修正当前策略。`
      : `[Debt Monitor] [${severity}] 拦截债务 ${val.toFixed(1)}。注意输出质量门控。`,
    severity: severity as any,
    blockToolPattern: /.*/, // 拦截过多时全阻断
    fixSuggestion: '全面修正策略，检查每次输出质量',
  }),
};
