/**
 * ErrorAuditInjector — 在 tool 错误后将审计追踪注入上下文。
 *
 * 当最近一轮 toolCall 出现失败时，查询 FileActionAudit 最近记录，
 * 将审计摘要注入为 system reminder，帮助 AI 排查根因。
 *
 * 注册 variant: 'error-audit'
 */

import { DynamicInjector } from './injector';
import { InsertPosition } from './position-strategy';
import type { Agent } from '..';
import type { FileActionAuditEntry } from '../audit/file-action-audit';

export class ErrorAuditInjector extends DynamicInjector {
  protected readonly injectionVariant = 'error-audit';

  constructor(agent: Agent) {
    super(agent);
  }

  /** 审计错误摘要注入到上下文中间位置 */
  override getTargetPosition(): InsertPosition {
    return InsertPosition.MID_CONTEXT;
  }

  protected getInjection(): string | undefined {
    // 仅当存在 fileActionAudit 实例才注入
    const audit = (this.agent as any).fileActionAudit as
      | { getRecentEntries: (n: number) => FileActionAuditEntry[] }
      | undefined;
    if (!audit) return undefined;

    const recent = audit.getRecentEntries(5);
    const failures = recent.filter((e) => !e.success);
    if (failures.length === 0) return undefined;

    const summary = failures
      .map(
        (f) =>
          `- ${f.action} (${f.toolCallId}) — ${f.resultPreview}${
            f.durationMs ? ` — ${f.durationMs}ms` : ''
          }`,
      )
      .join('\n');

    return `## 文件操作审计（最近 ${failures.length} 条失败记录）\n请关注以下文件操作异常，可能与此前工具调用有关：\n${summary}`;
  }
}
