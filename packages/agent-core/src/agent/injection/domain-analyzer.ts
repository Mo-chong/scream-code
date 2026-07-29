/**
 * ContextDomainAnalyzer — 语义域分析器
 *
 * 分析最近对话+工具调用，推断当前活跃的"知识域"。
 * InjectionRouter 据此跳过不相关的注入器，减少噪音。
 *
 * 不引入向量检索、不消耗 context token、纯静态分析。
 */

/** 工具名 → 活跃域映射 */
const TOOL_DOMAIN_MAP: Record<string, string[]> = {
  codegraph_node: ['codegraph'],
  codegraph: ['codegraph'],
  Edit: ['interception', 'deviation_chain'],
  Write: ['interception'],
  Read: ['codegraph'],
  Grep: ['codegraph'],
  LSP: ['codegraph'],
};

/** 关键词 → 活跃域映射（从最近 AI 推理文本中匹配）*/
const KEYWORD_DOMAIN_MAP: Array<{ pattern: RegExp; domains: string[] }> = [
  { pattern: /\b(偏差链|deviation|quality.*降|stuck|loop|循环|连续.*编辑)\b/i, domains: ['deviation_chain'] },
  { pattern: /\b(收敛门|convergence|gate.*阻断|拦截|block|gated)\b/i, domains: ['convergence_gate'] },
  { pattern: /\b(审计|audit|event.*log|记录|tracking|墨克尔|merkle|sha256)\b/i, domains: ['audit_chain'] },
  { pattern: /\b(codegraph|explore.*代码|symbol|调用图|call.*graph|依赖)\b/i, domains: ['codegraph'] },
  { pattern: /\b(注入|injection|injector|system.*prompt|router|dispatch)\b/i, domains: ['injection_system'] },
  { pattern: /\b(拦截|interception|guard|A组|B组|C组|收敛)\b/i, domains: ['interception'] },
  { pattern: /\b(蒸馏|distillation|mask|压缩|summarize|裁剪)\b/i, domains: ['distillation_tower'] },
];

/** 全局活跃域缓存（每步更新一次）*/
let cachedDomains: string[] = [];
let cachedAtStep = -1;

export type DomainInput = {
  currentStep: number;
  /** 上一步的推理文本 */
  reasoningText: string;
  /** 上一步调用的工具名列表 */
  toolNames: string[];
};

/**
 * 分析当前上下文，返回活跃的域列表。
 * 结果缓存到 currentStep 变化才重算。
 */
export function analyzeActiveDomains(input: DomainInput): string[] {
  if (input.currentStep === cachedAtStep) return cachedDomains;

  const active = new Set<string>();

  // 从工具调用推断
  for (const name of input.toolNames) {
    const mapped = TOOL_DOMAIN_MAP[name];
    if (mapped) mapped.forEach(d => active.add(d));
  }

  // 从推理文本关键词推断
  for (const entry of KEYWORD_DOMAIN_MAP) {
    if (entry.pattern.test(input.reasoningText)) {
      entry.domains.forEach(d => active.add(d));
    }
  }

  cachedDomains = [...active];
  cachedAtStep = input.currentStep;
  return cachedDomains;
}

/** 清除缓存（层间切换时调用） */
export function clearDomainCache(): void {
  cachedDomains = [];
  cachedAtStep = -1;
}

/**
 * 注入器→域映射。
 * undefined = 核心注入器，始终激发。
 * 空数组 = 始终激发。
 * 非空数组 = 域匹配时才激发。
 */
export const INJECTOR_DOMAIN_MAP: Record<string, string[] | undefined> = {
  // 核心（始终激发）
  'user-prefs': undefined,
  'plugin-session-start': undefined,
  'plan-mode': undefined,
  'permission-mode': undefined,
  wolfpack: undefined,
  'todo-list': undefined,
  goal: undefined,
  'working-set': undefined,
  'session-summary': undefined,
  'knowledge-menu': undefined,
  'archival-summary': undefined,

  // 域门控（仅在相关域活跃时激发）
  system_ref_stuck: ['deviation_chain'],
  'guard-feedback': ['deviation_chain', 'convergence_gate'],
  'error-audit': ['audit_chain', 'interception'],
  'decision-trace': ['audit_chain'],
  intent_guidance: ['injection_system'],
};

/** 判断注入器是否应基于域跳过 */
export function shouldSkipByDomain(id: string, activeDomains: string[]): boolean {
  const domains = INJECTOR_DOMAIN_MAP[id];
  if (domains === undefined) return false; // 核心 → 不跳过
  if (domains.length === 0) return false; // 始终激发 → 不跳过
  return !domains.some(d => activeDomains.includes(d));
}
