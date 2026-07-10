/**
 * 增量摘要提取模块
 *
 * 从助手的消息（assistant 消息）中提取关键决策和操作，
 * 用于长期上下文保底。不调 LLM——纯文本正则匹配。
 *
 * 提取原则：
 * - 不提取工具输出（噪声）
 * - 提取助手做了什么决定（"改了 server.ts 端口"、"读了 user.ts"）
 * - 每 30 步增量追加，用新替旧
 */

export interface SummaryEvent {
  readonly step: number;
  /** 提取的单行摘要（如 "edit server.ts port 3000→4000"） */
  readonly text: string;
}

/** 从助手消息中提取关键事件。纯文本处理，零 token 额外成本。 */
export function extractSummaryEvents(messages: readonly string[], stepOffset: number): SummaryEvent[] {
  const events: SummaryEvent[] = [];

  for (let i = 0; i < messages.length; i++) {
    const text = messages[i];
    if (!text) continue;

    // 提取模式1: "读了 {文件}" → readFile 事件
    const readMatch = text.match(/读了\s*[`"']?([^`"'\s，。]+)/);
    if (readMatch) {
      events.push({ step: stepOffset + i, text: `readFile ${readMatch[1]}` });
    }

    // 提取模式2: "改了 {文件}" / "修改了 {文件}" → edit 事件
    const editMatch = text.match(/(?:改了|修改了|编辑了)\s*[`"']?([^`"'\s，。]+)/);
    if (editMatch) {
      events.push({ step: stepOffset + i, text: `edit ${editMatch[1]}` });
    }

    // 提取模式3: "创建了 {文件}" → write 事件
    const createMatch = text.match(/(?:创建了|新建了|写了)\s*[`"']?([^`"'\s，。]+)/);
    if (createMatch) {
      events.push({ step: stepOffset + i, text: `writeFile ${createMatch[1]}` });
    }

    // 提取模式4: "验证 {目标}"
    const verifyMatch = text.match(/(?:验证|测试|检查)\s*([^，。]+)/);
    if (verifyMatch) {
      events.push({ step: stepOffset + i, text: `verify ${verifyMatch[1].trim()}` });
    }

    // 提取模式5: "安装了 {包}" → npm install 事件
    const installMatch = text.match(/(?:安装|装)\s*(?:npm\s*)?([^，。]+)/);
    if (installMatch) {
      events.push({ step: stepOffset + i, text: `install ${installMatch[1].trim()}` });
    }

    // 提取模式6: 纯命令执行（`xxx` 格式）
    const cmdMatch = text.match(/`([^`]+)`.*?(?:运行|执行|成功了|完成了)/);
    if (cmdMatch) {
      events.push({ step: stepOffset + i, text: `run ${cmdMatch[1]}` });
    }
  }

  return events;
}

/** 将事件列表编译为摘要文本。一行一个事件。 */
export function compileSummary(events: SummaryEvent[], maxLines: number = 6): string {
  // 去重（相同 text 的事件只保留最新的）
  const seen = new Set<string>();
  const deduped: SummaryEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const key = e.text;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.unshift(e);
    }
  }

  // 只保留最近的 maxLines 条
  const recent = deduped.slice(-maxLines);
  return recent.map((e) => `  step ${e.step}: ${e.text}`).join('\n');
}

/** 合并新旧摘要（增量追加） */
export function mergeSummaries(oldSummary: string, newEvents: SummaryEvent[], maxLines: number = 6): string {
  // 从旧摘要解析已有事件
  const existing: SummaryEvent[] = [];
  for (const line of oldSummary.split('\n')) {
    const m = line.match(/^\s*step (\d+): (.+)$/);
    if (m) {
      existing.push({ step: parseInt(m[1]), text: m[2] });
    }
  }

  // 合并新旧
  const merged = [...existing, ...newEvents];
  return compileSummary(merged, maxLines);
}
