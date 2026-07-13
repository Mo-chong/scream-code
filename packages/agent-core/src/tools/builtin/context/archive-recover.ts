import { z } from 'zod';
import { toInputJsonSchema } from '../../support/input-schema';
import type { BuiltinTool } from '../../../agent/tool/types';
import type { ExecutableToolContext, ExecutableToolResult } from '../../../loop';
import { TruncationTracker } from '../../../agent/turn/truncation-tracker';

// ── Schema ──

const ArchiveRecoverInputSchema = z.object({
  key: z.string().optional().describe('精确匹配 ContentArchive key，返回单条内容'),
  keys: z.array(z.string()).optional().describe('批量取回：传一组 key，返回对应内容的数组'),
  query: z.string().optional().describe('模糊搜索 key（key.includes(query)），返回所有匹配'),
}).strict();

export type ArchiveRecoverInput = z.infer<typeof ArchiveRecoverInputSchema>;

// ── Tool ──

export class ArchiveRecoverTool implements BuiltinTool<ArchiveRecoverInput> {
  readonly name = 'ArchiveRecover' as const;
  readonly description =
    '从内容存档中按 key 或关键词恢复之前截断/存档的内容。' +
    'key 格式为 tool:{callId}（如 tool:call_00_abc），遮蔽消息中会提示具体 key。' +
    '支持批量取回（传 keys 数组）。不传参数则列出所有可用 key（仅索引，不含内容）。';

  readonly parameters: Record<string, unknown> = toInputJsonSchema(ArchiveRecoverInputSchema);

  constructor(
    private readonly contentArchive: import('../../../agent/context/content-archive').ContentArchive,
  ) {}

  resolveExecution(args: ArchiveRecoverInput): import('../../../loop').ToolExecution {
    return {
      description: 'ArchiveRecover',
      approvalRule: this.name,
      execute: async (_ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
        if (args.key) {
          const content = this.contentArchive.recover(args.key);
          if (content && TruncationTracker.current) {
            TruncationTracker.current.markRecovered(args.key);
          }
          if (content === null) {
            return {
              output: JSON.stringify({
                key: args.key,
                error: 'key 不存在',
                hint: 'key 可能已过期（TTL 4 小时）或被 LRU 淘汰，请尝试重新调工具获取最新内容',
              }),
            };
          }
          // 统一用 JSON.stringify 返回以确保 UTF-8/Unicode 正确编码
          return { output: JSON.stringify({ key: args.key, content }) };
        }

        if (args.keys && args.keys.length > 0) {
          const results: Array<{ key: string; content: unknown } | { key: string; error: string }> = [];
          for (const k of args.keys) {
            const c = this.contentArchive.recover(k);
            if (c && TruncationTracker.current) {
              TruncationTracker.current.markRecovered(k);
            }
            if (c === null) {
              results.push({ key: k, error: 'key 不存在' });
            } else {
              results.push({ key: k, content: c });
            }
          }
          return { output: JSON.stringify({ count: results.length, results }) };
        }

        if (args.query) {
          const keys = this.contentArchive.list().filter((k) => k.includes(args.query!));
          return {
            output: JSON.stringify({
              count: keys.length,
              entries: keys
                .map((k) => ({ key: k, content: this.contentArchive.recover(k) }))
                .filter((e) => e.content !== undefined),
            }),
          };
        }

        return { output: JSON.stringify({ keys: this.contentArchive.list() }) };
      },
    };
  }
}
