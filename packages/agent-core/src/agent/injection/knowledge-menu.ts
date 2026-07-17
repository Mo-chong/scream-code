/**
 * KnowledgeMenuInjector — AI 主动知识请求菜单
 *
 * 在 session 启动时（step 1）注入可用知识域菜单。
 * 告诉 AI 它能通过输出 "REQUEST: <topic>" 主动请求更多上下文。
 *
 * 设计思路（Self-RAG 简化版）：
 *   模型能感知自己知识边界（calibration），但默认不暴露。
 *   明确告诉它"你可以要" + "有什么可要" = 释放自我感知能力。
 *   比系统替它判断该注入什么更省 token、更精准。
 *
 * 缓存安全：不修改消息历史，只通过 appendSystemReminder 追加。
 */
import { DynamicInjector } from './injector';
import type { Agent } from '..';

/** 知识域 → 注入内容的映射 */
const KNOWLEDGE_SNIPPETS: Record<string, string> = {
  deviation_chain:
    '[Knowledge: 偏差链 (Deviation Chain)]\n' +
    '偏差链检测 4 种质量偏差：C1(工具循环) C2(空回复) C3(重复探索) C4(内容退化)。\n' +
    '当偏差链连续触发 → 收敛门 G3 拦截 + 要求修正。偏差链事件记入 event-log，\n' +
    '供 QualityScore 聚合。不会阻断正常操作，只在质量持续下降时介入。',

  convergence_gate:
    '[Knowledge: 收敛门 (Convergence Gate)]\n' +
    '收敛门在 AI 输出时触发，检查 3 个条件：\n' +
    'G1(无意义回复) G2(事实冲突) G3(权限不达标)。gated=HARD 时硬阻断；\n' +
    'gated=SOFT 时注入纠正消息。收敛门有 severity 分区：HIGH(硬阻断)/LOW(软提示)。\n' +
    '[CRITICAL] 收敛门是最后防线 — 触发说明需要认真修正策略。',

  distillation_tower:
    '[Knowledge: 蒸馏塔 (Distillation Tower)]\n' +
    '3 层结构：保真层(full) → 压缩层(masked) → 归档层(audit summary)。\n' +
    '只对 codegraph 的 L3(源码块) 做压缩，L1(文件索引)+L2(符号关系) 完整保留。\n' +
    '压缩策略：识别 \`\`\` 分隔符，L1+L2 不走截断，L3 块级保留整函数/整类。\n' +
    '在 >50K token 时，ArchivalSummaryInjector 追加结构化摘要到尾部。',

  debt_model:
    '[Knowledge: 债务模型 (Exploration Debt)]\n' +
    '每次低效探索 +0.5 债务。探索债务达 carryover+4 触发 WARNING 提醒，\n' +
    '达 carryover+7 触发 CRITICAL 警告（将导致阻断）。\n' +
    'Bash 超时不扣债（Win11 环境问题不扣 AI）。\n' +
    '债务跨回合 carryover=min(2, floor(debt))，不会每次从零开始。\n' +
    'codegraph 调用不减债（防 dummy call 作弊），靠自然衰减。',

  audit_chain:
    '[Knowledge: 审计链 (Audit Chain)]\n' +
    '墨克尔事件审计链：event-log 的每一条记录都包含 SHA256 哈希，\n' +
    '形成 append-only 链。任何对历史记录的篡改会被 verify() 检测。\n' +
    '记录类型：interception(deviations/convergence)、injection、faithfulness、quality_score。\n' +
    '纯后台记录，不消耗 context token，不打断 AI。',

  codegraph:
    '[Knowledge: codegraph 工具链]\n' +
    '3 种查询方式：\n' +
    '  1) codegraph_explore — 大面积未知探索用 maxFiles=12，已知模块用 maxFiles=3\n' +
    '  2) codegraph_node — 已知符号精准查询（source+callers+callees），比 LSP+Read 更准\n' +
    '  3) codegraph — callees(function)/impact(symbol)/affected(path)\n' +
    '优先顺序：explore(未知) → node(已知符号) → LSP(单一文件) → Read/Grep(兜底)\n' +
    'codegraph 结果自动蒸馏：L1+L2 完整保，L3 源码块裁剪。',

  injection_system:
    '[Knowledge: 注入系统 (Injection System)]\n' +
    '15 个 DynamicInjector，通过 InjectionRouter 的 6 道门 + maxInjectionsPerStep=5 管控。\n' +
    '注入器按优先级调度：session-start → user-prefs → guard-feedback → intent → error-audit → ...\n' +
    'Budget cap per step: 5 条注入。超出排队到下一步。\n' +
    'system_trigger(收敛门)穿透 budget；quality_escalate_ 穿透 budget。',

  interception:
    '[Knowledge: 拦截系统 (Interception)]\n' +
    '三段式：A组(工具执行前) → B组(工具结果后) → C组(AI响应后收敛门)。\n' +
    'A组: reference_policy(Edit前查调用方) + output_constraint(格式约束)\n' +
    'B组: step_valid(空回复/事实冲突) + step_code_explore(探索债务) + code_explore(carryover)\n' +
    'C组: convergence gate (G1-G3) + 收敛硬限制',
};

/** 请求主题列表（供 menu 展示）*/
const MENU_ITEMS = [
  { id: 'deviation_chain', label: '偏差链', cn: '偏差链 — 质量偏差检测与收敛' },
  { id: 'convergence_gate', cn: '收敛门 — 输出质量门控与阻断' },
  { id: 'distillation_tower', cn: '蒸馏塔 — 工具结果压缩与归档' },
  { id: 'debt_model', cn: '债务模型 — 探索债务机制' },
  { id: 'audit_chain', cn: '审计链 — 墨克尔事件审计' },
  { id: 'codegraph', cn: 'codegraph — 代码智能查询' },
  { id: 'injection_system', cn: '注入系统 — DynamicInjector 管线' },
  { id: 'interception', cn: '拦截系统 — 三段式拦截架构' },
];

export class KnowledgeMenuInjector extends DynamicInjector {
  constructor(protected override readonly agent: Agent) {
    super(agent);
  }

  get name(): string { return 'knowledge-menu'; }
  get description(): string { return 'Injects available-knowledge menu at session start'; }
  override get injectionVariant(): string { return 'knowledge_menu'; }

  protected override getInjection(): string | undefined {
    const step = this._lastInjectContext?.currentStep;
    if (step !== 1) return undefined; // 仅 session 启动时注入

    const activeDomains = this._lastInjectContext?.activeDomains;
    let items = MENU_ITEMS;
    if (activeDomains && activeDomains.length > 0) {
      const matched = MENU_ITEMS.filter(item => activeDomains.includes(item.id));
      if (matched.length > 0) items = matched;
    }

    const lines = items.map(item =>
      `  "${item.id}" — ${item.cn}`,
    );

    return (
      '<system-reminder>\n' +
      '[Knowledge Menu]\n' +
      'The following knowledge is available on request. When you encounter a topic\n' +
      'below and need details, output "REQUEST: <topic>" to have it injected.\n' +
      lines.join('\n') +
      '\n</system-reminder>'
    );
  }
}

/** 解析 AI 输出中的 REQUEST: 标记并返回对应的知识内容 */
export function resolveKnowledgeRequest(text: string): string | null {
  const m = text.match(/REQUEST:\s*(\S+)/i);
  if (!m) return null;

  const topic = m[1].toLowerCase().replace(/[^a-z_]/g, '');
  return KNOWLEDGE_SNIPPETS[topic] ?? null;
}
