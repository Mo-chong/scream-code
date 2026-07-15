/**
 * OutputConstraint — 工具输出格式约束注册表
 *
 * 在 AI 调用工具前注入格式约束，减少"输出格式错误"类工具报错。
 * 让 AI 省下思考"该用什么格式"的注意力，集中到推理上。
 *
 * 设计原则：
 *   - 只对格式复杂/报错率高的工具加约束（Edit/Write 优先）
 *   - 约束行文用 MUST/格式示例，不啰嗦
 *   - 不引入运行时 schema 验证（Pure Guidance 模式）
 */

export interface OutputConstraint {
  toolMatch: RegExp;
  hint: string;
}

const CONSTRAINTS: OutputConstraint[] = [
  {
    toolMatch: /^(Edit)$/,
    hint: `Edit output MUST be: file path + exact old_string + replacement. Ensure old_string matches content verbatim — include enough surrounding lines for uniqueness.`,
  },
  {
    toolMatch: /^(Write)$/,
    hint: `Write output MUST be: file path + full content. Never use "<<<<<<<" merge markers in content.`,
  },
  {
    toolMatch: /^(Bash)$/,
    hint: `Bash output MUST be: single shell command with all necessary &&/|| chains. Prefer built-in tools (Read/Edit/Write/Grep) over sed/awk/echo. Use forward slashes for Windows paths.`,
  },
];

/**
 * 根据工具名获取对应格式约束提示
 */
export function getOutputConstraint(toolName: string): string | null {
  for (const c of CONSTRAINTS) {
    if (c.toolMatch.test(toolName)) {
      return c.hint;
    }
  }
  return null;
}
