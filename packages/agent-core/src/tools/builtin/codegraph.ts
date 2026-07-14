import { execSync } from 'child_process';
import type { Agent } from '../../agent';
import type { ExecutableTool, ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../loop';

interface CodeGraphInput {
  command: 'callees' | 'impact' | 'affected';
  /** 符号名（用于 callees/impact）或文件路径（用于 affected） */
  target: string;
}

const INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    command: {
      type: 'string' as const,
      enum: ['callees', 'impact', 'affected'],
      description: 'callees: 查函数内部调用了谁 | impact: 重构影响分析 | affected: 关联哪些测试文件',
    },
    target: {
      type: 'string' as const,
      description: '符号名（callees/impact 用，如 AuthService.login）或文件路径（affected 用，如 src/auth.ts）',
    },
  },
  required: ['command', 'target'],
};

export class CodeGraphTool implements ExecutableTool<CodeGraphInput> {
  readonly name = 'codegraph';
  readonly description = '通过 codegraph 索引查函数内部调用链(callees)、重构影响(impact)、关联测试(affected)。比 explore 更精准省 token。';
  readonly parameters = INPUT_SCHEMA;

  constructor(private agent: Agent) {}

  resolveExecution(input: CodeGraphInput): ToolExecution {
    const { command, target } = input;

    if (!['callees', 'impact', 'affected'].includes(command)) {
      return { isError: true, output: `未知 codegraph 命令: ${command}。支持: callees, impact, affected` };
    }
    if (!target || target.trim().length === 0) {
      return { isError: true, output: '请提供目标符号名或文件路径' };
    }

    return {
      approvalRule: this.name,
      execute: async (_ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
        try {
          const result = execSync(`codegraph ${command} "${target}" --max-files 1 2>/dev/null`, {
            encoding: 'utf-8',
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
          });
          return { output: result.trim() || `未找到 ${command} 结果: ${target}` };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { isError: true, output: `codegraph ${command} 失败: ${msg}` };
        }
      },
    };
  }
}
