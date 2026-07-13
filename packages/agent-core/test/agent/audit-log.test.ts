import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildAuditEntry, AuditLogWriter } from '../../src/agent/usage/audit-log';
import { shouldTriggerPersistentSummary, computeILR, getSummaryLevel } from '../../src/agent/turn/index';
import type { CacheMetrics } from '../../src/agent/usage/audit-log';

// Phase36: 测试工具函数——构建 mock history 模拟 maskToolObservations 效果
function makeHistory(toolCount: number, maskedPrefixCount: number, unmaskedSize = 50, maskedSize = 500): { role: string; content: { text: string }[] }[] {
  const msgs: { role: string; content: { text: string }[] }[] = [];
  for (let i = 0; i < toolCount; i++) {
    const isMasked = i < maskedPrefixCount;
    msgs.push({
      role: 'tool',
      content: [{ text: isMasked ? '[已遮蔽·key:micro:call_' + i + '·Read·archive_recover可取回]' : 'x'.repeat(unmaskedSize) }],
    });
  }
  return msgs;
}

describe('computeILR — 信息损失率计算', () => {
  it('无 tool 消息时 ILR=0', () => {
    expect(computeILR([], 3)).toBe(0);
    expect(computeILR([{ role: 'user', content: [{ text: 'hi' }] }], 3)).toBe(0);
  });

  it('≤3 条 tool 时 ILR=0（都在 keepLastN 内，不被 mask）', () => {
    const h3 = makeHistory(3, 0);
    expect(computeILR(h3, 3)).toBe(0);
    const h2 = makeHistory(2, 0);
    expect(computeILR(h2, 3)).toBe(0);
  });

  it('4 条 tool 中前 1 条被 mask → ILR > 0', () => {
    const h4 = makeHistory(4, 1, 50, 500);
    const ilr = computeILR(h4, 3);
    expect(ilr).toBeGreaterThan(0);
    expect(ilr).toBeLessThan(1);
  });

  it('全部 tool 被 mask → ILR > 0', () => {
    const h = makeHistory(10, 7, 50, 2000);
    const ilr = computeILR(h, 3);
    expect(ilr).toBeGreaterThan(0.5);
    expect(ilr).toBeLessThan(1);
  });
});

describe('getSummaryLevel — 分级逻辑', () => {
  it('ILR=0 → none', () => expect(getSummaryLevel(0)).toBe('none'));
  it('ILR>0 且 ≤0.6 → factual', () => { expect(getSummaryLevel(0.3)).toBe('factual'); expect(getSummaryLevel(0.6)).toBe('factual'); });
  it('ILR>0.6 → full', () => { expect(getSummaryLevel(0.61)).toBe('full'); expect(getSummaryLevel(1)).toBe('full'); });
});

describe('shouldTriggerPersistentSummary — ILR 触发决策', () => {
  it('有 tool 被 mask（ILR>0）时触发', () => {
    const h = makeHistory(5, 2, 50, 500);
    expect(shouldTriggerPersistentSummary(h, 5)).toBe(true);
  });

  it('全部 tool 在 keepLastN 内（ILR=0）时不触发', () => {
    const h = makeHistory(3, 0);
    expect(shouldTriggerPersistentSummary(h, 0)).toBe(false);
    expect(shouldTriggerPersistentSummary(h, 10)).toBe(false); // step 大但信息没丢
  });

  it('只有短输出（<100 字符）→ 不触发', () => {
    // 6 条 tool，全部 unmasked（maskedPrefixCount=0），每条 50 字符（<100），不会被 mask
    const h = makeHistory(6, 0, 50, 50);
    expect(computeILR(h, 3)).toBe(0);
    expect(shouldTriggerPersistentSummary(h, 6)).toBe(false);
  });
});

describe('summaryTriggered — 同步设 → buildAuditEntry 读取时序', () => {
  // 构建一个有 ILR>0 的 mock history（5 tool, 2 被 mask）
  const triggerHistory = makeHistory(5, 2, 50, 500);
  const noTriggerHistory = makeHistory(2, 0, 50, 50);

  it('同步设置 true 后 buildAuditEntry 立即读到 true（验证 L2059→L1783 时序）', () => {
    let _summaryTriggered = false;
    const stepCount = 10;

    // 模拟 updatePersistentSummary 核心 (L2058-2064)
    _summaryTriggered = false;                                  // L2059 reset
    if (shouldTriggerPersistentSummary(triggerHistory, stepCount)) {            // L2061 真实函数
      _summaryTriggered = true;                                 // L2064 sync set
    }

    // 模拟 buildAuditEntry (L1783) 在同一同步流中读取
    const entry = buildAuditEntry(
      1, 'test', 'sess-1',
      { hitRatio: 0.8, totalInput: 1000, hitTokens: 800, missTokens: 200 } as CacheMetrics,
      false, 0, [], false, false, undefined,
      stepCount, 0, _summaryTriggered,
    );

    expect(_summaryTriggered).toBe(true);
    expect(entry.summaryTriggered).toBe(true);
  });

  it('重置机制：触发后下轮读到 false（验证 L2059 reset 生效）', () => {
    let _summaryTriggered = false;

    // 第一轮: 有 ILR > 0 → 触发
    _summaryTriggered = false;
    if (shouldTriggerPersistentSummary(triggerHistory, 10)) _summaryTriggered = true;
    expect(_summaryTriggered).toBe(true);

    // 第二轮: reset + ILR=0 → 不触发
    _summaryTriggered = false;
    if (shouldTriggerPersistentSummary(noTriggerHistory, 3)) _summaryTriggered = true;

    const entry = buildAuditEntry(
      2, 'test', 'sess-1',
      { hitRatio: 0.8, totalInput: 1000, hitTokens: 800, missTokens: 200 } as CacheMetrics,
      false, 0, [], false, false, undefined,
      3, 0, _summaryTriggered,
    );
    expect(_summaryTriggered).toBe(false);
    expect(entry.summaryTriggered).toBe(false);
  });
});

describe('buildAuditEntry — 序列化', () => {
  it('summaryTriggered true 时 JSON 含字段', () => {
    const entry = buildAuditEntry(1, 't', 's', {
      hitRatio: 0.8, totalInput: 1000, hitTokens: 800, missTokens: 200,
    }, false, 0, [], false, false, undefined, 8, 2, true);
    const p = JSON.parse(JSON.stringify(entry));
    expect(p.summaryTriggered).toBe(true);
    expect(p.turnStepCount).toBe(8);
    expect(p.pendingRecoverKeys).toBe(2);
  });

  it('summaryTriggered false 时 JSON 含字段', () => {
    const entry = buildAuditEntry(2, 't', 's', {
      hitRatio: 0.8, totalInput: 1000, hitTokens: 800, missTokens: 200,
    }, false, 0, [], false, false, undefined, 3, 0, false);
    const p = JSON.parse(JSON.stringify(entry));
    expect(p.summaryTriggered).toBe(false);
    expect(p.turnStepCount).toBe(3);
  });

  it('默认值 false/0 时 JSON 不省略 key', () => {
    const entry = buildAuditEntry(3, 't', 's', {
      hitRatio: 0.8, totalInput: 1000, hitTokens: 800, missTokens: 200,
    }, false, 0, [], false, false, undefined);
    const json = JSON.stringify(entry);
    expect(json).toContain('"summaryTriggered"');
    expect(json).toContain('"turnStepCount"');
    expect(json).toContain('"pendingRecoverKeys"');
  });
});

describe('AuditLogWriter — ndjson 文件头', () => {
  it('init() 写入的 header 含 3 个新字段名', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'scream-audit-'));
    const writer = new AuditLogWriter({ logDir: tmpDir });
    await writer.init();
    const d = new Date();
    const localToday = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const fp = join(tmpDir, `cache-audit-${localToday}.ndjson`);
    expect(existsSync(fp)).toBe(true);
    const content = readFileSync(fp, 'utf-8');
    expect(content).toContain('turnStepCount');
    expect(content).toContain('pendingRecoverKeys');
    expect(content).toContain('summaryTriggered');
    writer.destroy();
    await new Promise(r => setTimeout(r, 100));
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
