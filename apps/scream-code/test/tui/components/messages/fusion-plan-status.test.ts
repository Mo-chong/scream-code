import type { TUI } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { FusionPlanStatusComponent } from '#/tui/components/messages/fusion-plan-status';
import { darkColors } from '#/tui/theme/colors';
import type { FusionPlanStatusData } from '#/tui/types';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function createMockUI(): TUI {
  return { requestRender: vi.fn() } as unknown as TUI;
}


function baseStatus(overrides?: Partial<FusionPlanStatusData>): FusionPlanStatusData {
  return {
    phase: 'planning',
    completedWorkers: 0,
    totalWorkers: 3,
    failedWorkers: 0,
    workers: [
      { index: 0, status: 'running', angle: '', label: '最佳正确性' },
      { index: 1, status: 'pending', angle: '', label: '最小侵入性' },
      { index: 2, status: 'pending', angle: '', label: '最优架构性' },
    ],
    ...overrides,
  };
}

describe('FusionPlanStatusComponent', () => {
  it('renders header and worker list during planning', () => {
    const component = new FusionPlanStatusComponent(baseStatus(), darkColors, createMockUI());
    const lines = component.render(120).map((line) => strip(line).trimEnd());

    expect(lines[1]).toMatch(/融合计划 · 0\/3 个视角 · 规划中/);
    expect(lines.some((line) => line.includes('视角 1 · 最佳正确性'))).toBe(true);
    expect(lines.some((line) => line.includes('视角 2 · 最小侵入性'))).toBe(true);
    expect(lines.some((line) => line.includes('视角 3 · 最优架构性'))).toBe(true);
  });

  it('renders completed state without spinner', () => {
    const component = new FusionPlanStatusComponent(
      baseStatus({
        phase: 'completed',
        completedWorkers: 3,
        workers: [
          { index: 0, status: 'completed', angle: '', label: '最佳正确性' },
          { index: 1, status: 'completed', angle: '', label: '最小侵入性' },
          { index: 2, status: 'completed', angle: '', label: '最优架构性' },
        ],
      }),
      darkColors,
      createMockUI(),
    );
    const lines = component.render(120).map((line) => strip(line).trimEnd());

    expect(lines[1]).toMatch(/融合计划 · 3\/3 个视角 · 已完成/);
  });

  it('renders failed state with detail', () => {
    const component = new FusionPlanStatusComponent(
      baseStatus({
        phase: 'failed',
        failedWorkers: 3,
        detail: 'all workers failed',
        workers: [
          { index: 0, status: 'failed', angle: '', label: '最佳正确性' },
          { index: 1, status: 'failed', angle: '', label: '最小侵入性' },
          { index: 2, status: 'failed', angle: '', label: '最优架构性' },
        ],
      }),
      darkColors,
      createMockUI(),
    );
    const lines = component.render(120).map((line) => strip(line).trimEnd());

    expect(lines[1]).toMatch(/融合计划 · 0\/3 个视角（3 失败） · 失败/);
    expect(lines.some((line) => line.includes('all workers failed'))).toBe(true);
  });

  it('updates rendered content after setData', () => {
    const component = new FusionPlanStatusComponent(baseStatus(), darkColors, createMockUI());
    const before = component.render(120).map((line) => strip(line).trimEnd());
    expect(before[1]).toMatch(/规划中/);

    component.setData(baseStatus({ phase: 'synthesis', completedWorkers: 3 }));
    const after = component.render(120).map((line) => strip(line).trimEnd());
    expect(after[1]).toMatch(/融合中/);
  });

  it('caches render output for the same width', () => {
    const component = new FusionPlanStatusComponent(baseStatus(), darkColors, createMockUI());
    const first = component.render(120);
    const second = component.render(120);
    expect(second).toBe(first);
  });
});
