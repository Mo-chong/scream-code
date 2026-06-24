import type { Jian } from '@scream-code/jian';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type {
  ExecutableToolContext,
  ExecutableToolResult,
  RunnableToolExecution,
  ToolExecution,
} from '../../../loop/types';
import { renderPrompt } from '../../../utils/render-prompt';
import { literalRulePattern } from '../../support/rule-match';
import { toInputJsonSchema } from '../../support/input-schema';
import { partitionExistingPaths } from '../../support/suffix-match';
import type { WorkspaceConfig } from '../../support/workspace';
import { ReadTool } from './read';
import readGroupDescriptionTemplate from './read-group.md';

function toolOutputText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}

export const MAX_READ_GROUP_FILES = 10;

const NonEmptyStringArraySchema = z.array(z.string().min(1)).min(1).max(MAX_READ_GROUP_FILES);

export const ReadGroupInputSchema = z.object({
  paths: NonEmptyStringArraySchema.describe(
    `Array of file paths to read in parallel (1-${String(MAX_READ_GROUP_FILES)} files).`,
  ),
  line_offset: z
    .number()
    .int()
    .optional()
    .describe('Starting line number applied to every file.'),
  n_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum lines per file.'),
});

export type ReadGroupInput = z.Infer<typeof ReadGroupInputSchema>;

const READ_GROUP_DESCRIPTION = renderPrompt(readGroupDescriptionTemplate, {});

type ResolvedItem =
  | { path: string; exec: RunnableToolExecution }
  | { path: string; error: string };

export class ReadGroupTool implements BuiltinTool<ReadGroupInput> {
  readonly name = 'ReadGroup' as const;
  readonly description = READ_GROUP_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadGroupInputSchema);

  constructor(
    private readonly jian: Jian,
    private readonly workspace: WorkspaceConfig,
  ) {}

  resolveExecution(args: ReadGroupInput): ToolExecution {
    const paths = args.paths.slice(0, MAX_READ_GROUP_FILES);
    const readTool = new ReadTool(this.jian, this.workspace);

    // path-access rejection (sensitive / relative-outside) is detected here
    // synchronously — it throws PathSecurityError which we turn into an
    // error item. ENOENT is NOT detected here; it surfaces at execute time
    // via jian.stat, so multi-path partitioning runs in execution().
    const items: ResolvedItem[] = [];
    for (const path of paths) {
      try {
        const exec = readTool.resolveExecution({
          path,
          line_offset: args.line_offset,
          n_lines: args.n_lines,
        });
        if ('isError' in exec && exec.isError === true) {
          items.push({ path, error: toolOutputText(exec.output) });
        } else {
          items.push({ path, exec });
        }
      } catch (error) {
        items.push({
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const accesses = items
      .filter((e): e is { path: string; exec: RunnableToolExecution } => 'exec' in e)
      .flatMap((e) => e.exec.accesses ?? ToolAccesses.none());
    const sortedPaths = [...paths].toSorted();
    const approvalRule = literalRulePattern(this.name, sortedPaths.join('\n'));
    const deniedCount = items.filter((e) => 'error' in e).length;

    return {
      accesses,
      description:
        deniedCount > 0
          ? `Reading ${String(paths.length)} files (${String(deniedCount)} denied)`
          : `Reading ${String(paths.length)} files`,
      display: { kind: 'file_io', operation: 'read', path: paths.join(', ') },
      approvalRule,
      matchesRule: (ruleArgs) => ruleArgs === approvalRule,
      execute: (ctx: ExecutableToolContext) => this.execution(args, items, ctx),
    };
  }

  private async execution(
    args: ReadGroupInput,
    items: ResolvedItem[],
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const paths = items.map((i) => i.path);

    // Multi-path: batch-stat probe and skip missing entries (aligned with
    // omp partitionExistingPaths). Single-path keeps strict ENOENT semantics
    // so the Read tool's own suffix-match recovery can fire.
    let missingPaths: string[] = [];
    if (paths.length > 1) {
      const probePaths = items
        .filter((i) => 'exec' in i)
        .map((i) => i.path);
      if (probePaths.length > 0) {
        try {
          const partition = await partitionExistingPaths(probePaths, this.jian, this.workspace);
          missingPaths = partition.missing;
          if (partition.valid.length === 0 && items.every((i) => 'exec' in i)) {
            // All probed paths missing — report once instead of N identical errors.
            return {
              isError: true,
              output: `Paths not found: ${missingPaths.join(', ')}`,
            };
          }
        } catch {
          // Partition hit a non-ENOENT error (EACCES/EIO on stat). Fall
          // back to letting each Read surface its own error individually
          // so one bad path doesn't suppress the readable ones.
          missingPaths = [];
        }
      }
    }

    const missingSet = new Set(missingPaths);
    const results = await Promise.all(
      items.map(async (item) => {
        if ('error' in item) {
          return {
            path: item.path,
            result: { isError: true, output: item.error } satisfies ExecutableToolResult,
          };
        }
        if (missingSet.has(item.path)) {
          return {
            path: item.path,
            result: {
              isError: true,
              output: `"${item.path}" does not exist.`,
            } satisfies ExecutableToolResult,
          };
        }
        try {
          const result = await item.exec.execute(ctx);
          return { path: item.path, result };
        } catch (error) {
          return {
            path: item.path,
            result: {
              isError: true,
              output: error instanceof Error ? error.message : String(error),
            } satisfies ExecutableToolResult,
          };
        }
      }),
    );

    // Preserve original input order in the output.
    const orderIndex = new Map(paths.map((p, i) => [p, i]));
    results.sort((a, b) => (orderIndex.get(a.path) ?? 0) - (orderIndex.get(b.path) ?? 0));

    const parts: string[] = [];
    let hasError = false;
    for (const { path, result } of results) {
      if (parts.length > 0) parts.push('');
      parts.push(`--- ${path} ---`);
      if (result.isError === true) {
        hasError = true;
        parts.push(`[ERROR] ${toolOutputText(result.output)}`);
      } else {
        parts.push(toolOutputText(result.output));
      }
    }

    if (missingPaths.length > 0) {
      parts.push('', `Skipped missing paths: ${missingPaths.join(', ')}`);
    }

    return {
      isError: hasError,
      output: parts.join('\n'),
    };
  }
}
