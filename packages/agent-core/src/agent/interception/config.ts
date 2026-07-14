/**
 * InterceptionManager — Config
 *
 * 统一配置层。
 * Phase38a 基础设施 — 所有阈值 / 开关 / 递进参数集中管理，不硬编码。
 */

import type { InterceptionConfig } from './types';

/** 默认拦截系统配置 */
export const DEFAULT_INTERCEPTION_CONFIG: InterceptionConfig = {
  enabled: true,
  /** 单步最多输出 3 条拦截消息（超过则按优先级丢弃低优先级的） */
  maxMessagesPerStep: 3,

  priorities: {
    critical: {
      enabled: true,
      action: 'block_step',
      enableEscalation: false, // critical 直接阻断，不递进
    },
    normal: {
      enabled: true,
      action: 'inject_feedback',
      enableEscalation: true, // hint → nudge → warn → block
    },
    debug: {
      enabled: true,
      action: 'log_only',
      enableEscalation: false, // 纯日志，不注入
    },
  },

  escalation: {
    hintToNudge: 2,         // 第 2 次触发 → nudge
    nudgeToWarn: 4,         // 第 4 次触发 → warn
    warnToBlock: 6,         // 第 6 次触发 → block
    autoResetAfterSteps: 15, // 15 步无触发后重置计数
  },
};

/** 仅当穿越 `maxMessagesPerStep` 上限时，此映射决定哪个根因优先级最高 */
export const ROOT_CAUSE_PRIORITY_ORDER: readonly string[] = [
  'turn_limit',
  'tool_permission',
  'confabulation',
  'stuck_loop',
  'edit_discipline',
  'verify_discipline',
  'behavior_repeat',
  'quality_degrade',
  'attention_signal',
  'context_pressure',
  'log_info',
];
