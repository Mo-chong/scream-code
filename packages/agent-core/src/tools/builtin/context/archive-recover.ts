import { z } from 'zod';
import { toInputJsonSchema } from '../../support/input-schema';
import type { BuiltinTool } from '../../../agent/tool/types';
import type { ExecutableToolContext, ExecutableToolResult } from '../../../loop';

// ── Schema ──

const ArchiveRecoverInputSchema = z.object({
  key: z.string().optional().describe('精确匹配 ContentArchive key，返回单条内容'),
  query: z.string().optional().describe('模糊搜索 key（key.includes(query)），返回所有匹配'),
}).strict();

export type ArchiveRecoverInput = z.infer<typeof ArchiveRecoverInputSchema>;

// ── Tool ──

export class ArchiveRecoverTool implements BuiltinTool<ArchiveRecoverInput> {
  readonly name = 'ArchiveRecover' as const;
  readonly description =
    '从内容存档中按 key 或关键词恢复之前截断/存档的内容。' +
    '不传参数则列出所有可用 key（仅索引，不含内容）。传 key 精确匹配单条，传 query 模糊搜索全部匹配。';

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
          return { output: content ?? '未找到该 key 对应的存档内容' };
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
