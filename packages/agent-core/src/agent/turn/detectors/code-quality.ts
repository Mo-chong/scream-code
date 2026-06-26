/**
 * CodeQualityDetector — 代码质量检测纯函数。
 *
 * 与 detectConfabulation() / detectQualityIssue() / detectSceneMemory() 同级。
 * 纯函数，不依赖 TurnFlow 实例，不依赖注入系统。
 *
 * 检测范围：
 * - S1: 文件扩展名必须是 .ts/.tsx（禁止 .js/.jsx）
 * - S2: 禁止 `: any` 类型标注（允许显式 eslint-disable）
 * - S3: 函数参数和返回值必须有类型标注（显式签名）
 */

export interface CodeQualityViolation {
  file: string;          // 文件路径
  type: 'js_file' | 'any_type' | 'missing_sig';
  detail: string;        // 人类可读的描述
  line?: number;         // 行号（如适用）
}

export interface CodeQualityResult {
  violations: CodeQualityViolation[];
  totalScore: number;    // 0 = 完美，负数 = 违规评分
  hasViolations: boolean;
}

/**
 * 代码质量检测入口。
 * 在 Write/Edit 完成后调用。
 *
 * @param code - 写入的文件内容
 * @param filePath - 文件路径（用于判断扩展名和关联上下文）
 * @returns CodeQualityResult
 */
export function scanCodeQuality(code: string, filePath: string): CodeQualityResult {
  const violations: CodeQualityViolation[] = [];

  // S1: .js/.jsx 文件检测（仅对新文件）
  if (isJSFile(filePath)) {
    violations.push({
      file: filePath,
      type: 'js_file',
      detail: `文件 "${filePath}" 是 .js/.jsx 格式。项目规范要求全栈使用 TypeScript，请改用 .ts / .tsx 扩展名。`,
    });
  }

  // S2+S3: 基于行的检测
  if (isTSFile(filePath) || isJSFile(filePath)) {
    scanContent(code, filePath, violations);
  }

  return {
    violations,
    totalScore: -violations.length,
    hasViolations: violations.length > 0,
  };
}

function isJSFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return ext === '.js' || ext === '.jsx';
}

function isTSFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return ext === '.ts' || ext === '.tsx';
}

function scanContent(code: string, filePath: string, violations: CodeQualityViolation[]): void {
  const lines = code.split('\n');
  let eslintDisableAnyNextLine = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // 检测 eslint-disable 注释（下一行豁免）
    if (/\/\/\s*eslint-disable-next-line\s+@typescript-eslint\/no-explicit-any/.test(line)) {
      eslintDisableAnyNextLine = true;
      continue;
    }

    // 检查 :any（跳过显式豁免的行）
    if (eslintDisableAnyNextLine) {
      if (/: \s*any\b/.test(line)) {
        eslintDisableAnyNextLine = false; // 已豁免
        continue;
      }
      eslintDisableAnyNextLine = false; // 无 any，重置
      continue;
    }

    // S2: 检查 :any
    const anyMatch = line.match(/(\w+)\s*:\s*any\b/);
    if (anyMatch) {
      violations.push({
        file: filePath,
        type: 'any_type',
        detail: `第 ${i + 1} 行: "${anyMatch[1]}: any" — 禁止使用 any 类型。`
                + `请使用具体类型或添加 // eslint-disable-next-line @typescript-eslint/no-explicit-any 并注明理由。`,
        line: i + 1,
      });
    }
  }

  // S3: 函数签名类型标注检查（regex heuristic）
  if (isTSFile(filePath)) {
    const funcPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
    let match: RegExpExecArray | null;
    while ((match = funcPattern.exec(code)) !== null) {
      const params = match[2]!.split(',').map(p => p.trim()).filter(Boolean);
      for (const param of params) {
        if (!/:\s*\w/.test(param)) {
          violations.push({
            file: filePath,
            type: 'missing_sig',
            detail: `函数 ${match[1]}() 的参数 "${param}" 缺少类型标注。函数签名的参数和返回值必须显式声明类型。`,
          });
        }
      }
      // 检查返回值类型
      const restAfterParen = code.slice(match.index + match[0].length);
      const returnMatch = restAfterParen.match(/^\s*(:\s*(\w+[\w<>[\]|&, ]*))?\s*{/);
      if (returnMatch && !returnMatch[1]) {
        violations.push({
          file: filePath,
          type: 'missing_sig',
          detail: `函数 ${match[1]}() 缺少返回值类型标注。参数和返回值类型必须显式声明。`,
        });
      }
    }
  }
}

/**
 * 将检测结果格式化为注入文本。
 */
export function formatCodeQualityFeedback(result: CodeQualityResult): string {
  if (!result.hasViolations) return '';
  const lines = result.violations.map((v, i) =>
    `${i + 1}. ${v.detail}`
  );
  return [
    '【代码质量】检测到代码规范违规，请修正：',
    ...lines,
    '修正后再继续写新代码。',
  ].join('\n');
}
