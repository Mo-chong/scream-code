import { DynamicInjector, type ResidualConfig } from './injector';
import { InsertPosition } from './position-strategy';

/**
 * 数据锚点结构化提取的优先级排序：
 *   ERROR > FILE_CHANGE > API_RESPONSE > SEARCH_RESULT > STATUS_CODE
 *
 * 每条被 mask 的 tool 结果按优先级归类，只注入最高优先级的 2-3 条。
 * 避免全部展开，保持注入消息简洁。
 */

interface ToolRecord {
  text: string;       // 原始内容
  priority: number;   // 0=最高 (ERROR), 4=最低 (STATUS)
  label: string;      // 分类标签
  summary: string;    // 提取摘要（≤120字）
}

/** 判断是否为路径/版本号误匹配 */
function isPathOrVersion(text: string): boolean {
  return /^[\w\/\\\-.:]{5,}$/.test(text.trim())
    || /^\d+\.\d+\.\d+/.test(text.trim());
}

/** 结构化提取单条 tool 结果 */
function extractRecord(text: string): ToolRecord | null {
  if (!text || isPathOrVersion(text)) return null;

  const lower = text.toLowerCase();

  // P0: 错误/异常
  if (/error|fail(ed|ure)?|not found|exit code \d|TypeError|SyntaxError|ENOENT|ECONNREFUSED|timeout/i.test(lower)) {
    const snippet = text.length > 120 ? text.slice(0, 120) + '…' : text;
    return { text, priority: 0, label: 'ERROR', summary: snippet };
  }

  // P1: 文件变更
  if (text.startsWith('The file') || /wrote|written|old_string.*match|new_string/i.test(lower)) {
    const lines = text.split('\n').filter(l => l.includes('file') || l.includes('File')).join('; ');
    const snippet = (lines || text).length > 100 ? (lines || text).slice(0, 100) + '…' : (lines || text);
    return { text, priority: 1, label: 'FILE', summary: snippet };
  }

  // P2: API 响应
  if (/status|response|c(ode|all)\s+\d{3}|HTTP|api|fetch|request/i.test(lower) && !isPathOrVersion(text)) {
    const snippet = text.length > 100 ? text.slice(0, 100) + '…' : text;
    return { text, priority: 2, label: 'API', summary: snippet };
  }

  // P3: 搜索结果
  if (/result|match|found|query|search|grep|glob/i.test(lower) && text.length < 500) {
    const snippet = text.length > 100 ? text.slice(0, 100) + '…' : text;
    return { text, priority: 3, label: 'SEARCH', summary: snippet };
  }

  // P4: 状态码/其他
  return { text, priority: 4, label: 'STATUS', summary: text.length > 80 ? text.slice(0, 80) + '…' : text };
}

/**
 * ToolResultRecoveryInjector — 结构化工具结果恢复
 *
 * 按优先级 错误 > 文件变更 > API > 搜索 > 状态码 提取被 mask 的关键数据。
 * 只注入优先级最高的 2-3 条。
 */
export class ToolResultRecoveryInjector extends DynamicInjector {
  constructor(protected override readonly agent: any) {
    super(agent);
  }

  protected readonly injectionVariant = 'tool_result_recovery';

  override getTargetPosition(): InsertPosition {
    return InsertPosition.MID_CONTEXT;
  }

  override getResidualConfig(): ResidualConfig | undefined {
    return { weight: 0.6, decayPerStep: 0.85, threshold: 0.15, minStepGap: 3 };
  }

  protected override getInjection(): string | undefined {
    if (this._lastInjectContext?.currentStep !== 1) return undefined;

    const history: any[] = this.agent.context?.history ?? [];
    if (history.length === 0) return undefined;

    const toolMsgs = (history as any[]).filter(m => m.role === 'tool');
    const maskedCount = Math.max(0, toolMsgs.length - 3);
    if (maskedCount === 0) return undefined;

    const maskedTools = toolMsgs.slice(0, maskedCount);

    // 结构化提取并排序
    const records: ToolRecord[] = [];
    for (const t of maskedTools) {
      const text = t.content?.[0]?.text ?? '';
      const rec = extractRecord(text);
      if (rec) records.push(rec);
    }

    if (records.length === 0) return undefined;

    // 按优先级排序
    records.sort((a, b) => a.priority - b.priority);

    // 实盘数据驱动的阈值：93.2% 轮次 ILR≤0.3 已跳过
    // 剩下 6.1% ILR>0.6 的轮次中，只有含 ERROR/FILE/API 的才有恢复价值
    const hasHighValue = records.some(r => r.priority <= 2); // ERROR=0, FILE=1, API=2
    if (!hasHighValue) return undefined;

    const top = records.slice(0, 3);

    // ILR 估算
    const ilr = toolMsgs.length > 0 ? maskedCount / toolMsgs.length : 0;
    if (ilr <= 0.3) return undefined;

    const lines: string[] = [];
    lines.push(`<system-reminder>`);
    lines.push(`[tool-result-recovery] ILR=~${ilr.toFixed(2)}，${maskedCount} 条已遮蔽`);
    lines.push(`恢复优先级: ${[...new Set(top.map(r => r.label))].join(' > ')}`);

    for (const r of top) {
      lines.push(`[${r.label}] ${r.summary}`);
    }

    lines.push(`</system-reminder>`);
    return lines.join('\n');
  }
}
