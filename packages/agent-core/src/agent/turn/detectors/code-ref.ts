/**
 * CodeRefDetector — 检测 AI 输出中是否包含缺少路径/行号的代码块。
 *
 * 纯函数。输入 assistant 文本，输出检测结果。
 * 不走工具调用，不涉及状态。
 */

export interface CodeRefIssue {
  /** 是否有缺少路径/行号的代码块 */
  readonly hasMissingRef: boolean;
  /** 发现的缺失数量 */
  readonly count: number;
  /** 示例信息（第一条缺失的前一行内容） */
  readonly sample?: string;
}

/**
 * 检测 AI 回复中的代码块是否包含文件路径和行号范围。
 *
 * 规则：
 * - 代码块（```）前一行如果包含文件路径 → 合格
 * - 代码块前一行如果包含 "line N" 或 "line N-M" → 合格
 * - 否则 → 记录为缺失
 *
 * @param assistantText   AI 的纯文本回复
 * @returns               CodeRefIssue
 */
export function detectCodeRefQuality(assistantText: string): CodeRefIssue {
  const lines = assistantText.split('\n');
  let count = 0;
  let sample: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // 匹配代码块开始行（``` 或 ```lang）
    if (/^```\w*$/.test(line) && i > 0) {
      const prevLine = lines[i - 1]!;
      // 检查前一行是否有路径或行号标识
      const hasRef =
        /\.\w{1,4}\b/.test(prevLine) ||            // file.ts / file.py
        /\b(line|行)\s*\d+/i.test(prevLine) ||      // line 42 / 行 42
        /startLine|endLine|filepath/.test(prevLine); // 格式标签
      if (!hasRef && prevLine.trim().length > 0) {
        count++;
        if (!sample) sample = prevLine.slice(0, 80);
      }
    }
  }

  return { hasMissingRef: count > 0, count, sample };
}
