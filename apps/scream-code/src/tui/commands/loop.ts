import type { SlashCommandHost } from './dispatch';
import {
  createLoopLimitRuntime,
  describeLoopLimit,
  describeLoopLimitRuntime,
  parseLoopLimitArgs,
  type LoopLimitRuntime,
} from '../utils/loop-limit';

/**
 * 切换循环模式。开启后，下一条提示词会在每次 Agent 完成一轮后自动重发。
 * 用法：/loop [次数|时长] [提示词]
 * 示例：/loop 10, /loop 5m, /loop 10 继续优化
 */
export async function handleLoopCommand(host: SlashCommandHost, args: string): Promise<void> {
  if (host.state.appState.loopModeEnabled) {
    disableLoopMode(host, '循环模式已关闭。');
    return;
  }

  const parsed = parseLoopLimitArgs(args);
  if (typeof parsed === 'string') {
    host.showError(parsed);
    return;
  }

  const loopLimit = createLoopLimitRuntime(parsed.limit);
  host.setAppState({
    loopModeEnabled: true,
    loopPrompt: undefined,
    loopLimit,
  });

  const limitSuffix = parsed.limit ? ` 限制：${describeLoopLimit(parsed.limit)}。` : '';
  const remainingSuffix = loopLimit ? ` ${describeLoopLimitRuntime(loopLimit)}。` : '';
  const promptBehavior = parsed.prompt
    ? '已固定提示词，每轮结束后自动重发。'
    : '下一条提示词将在每轮结束后自动重发。';

  host.showNotice(
    '循环模式已开启',
    `${promptBehavior}${limitSuffix}${remainingSuffix}\n\n` +
      '/loop 命令说明：\n' +
      '· /loop — 切换循环开关\n' +
      '· /loop 10 [提示词] — 限制 10 次迭代\n' +
      '· /loop 5m [提示词] — 限制 5 分钟\n' +
      '· /loop 1h30m [提示词] — 组合时长限制\n' +
      '按 Esc 暂停当前迭代；再次输入 /loop 关闭循环。',
  );

  // 如果命令行附带提示词，则作为第一轮直接提交。
  if (parsed.prompt) {
    host.sendNormalUserInput(parsed.prompt);
  }
}

export function disableLoopMode(host: SlashCommandHost, message?: string): void {
  host.setAppState({
    loopModeEnabled: false,
    loopPrompt: undefined,
    loopLimit: undefined,
  });
  if (message) {
    host.showStatus(message);
  }
}

export function describeLoopStatus(
  enabled: boolean,
  prompt: string | undefined,
  limit: LoopLimitRuntime | undefined,
): string {
  if (!enabled) return '循环：关闭';
  if (limit) return `循环：开启（${describeLoopLimitRuntime(limit)}）`;
  if (prompt) return '循环：开启（正在重复提示词）';
  return '循环：开启（等待下一条提示词）';
}
