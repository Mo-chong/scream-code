import type { Component, TUI } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
  MESSAGE_INDENT,
} from '#/tui/constant/rendering';
import type { ColorPalette } from '#/tui/theme/colors';
import type { FusionPlanPhase, FusionPlanStatusData } from '#/tui/types';
const STATUS_ICONS: Record<FusionPlanStatusData['workers'][number]['status'], string> = {
  pending: '⏳',
  running: '⏳',
  completed: '✅',
  failed: '❌',
};
export class FusionPlanStatusComponent implements Component {
  private data: FusionPlanStatusData;
  private readonly colors: ColorPalette;
  private readonly ui: TUI;
  private spinnerFrame = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(data: FusionPlanStatusData, colors: ColorPalette, ui: TUI) {
    this.data = data;
    this.colors = colors;
    this.ui = ui;
    this.startSpinner();
  }

  setData(data: FusionPlanStatusData): void {
    this.data = data;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    if (this.isTerminal(data.phase)) {
      this.stopSpinner();
    } else if (this.intervalId === null) {
      this.startSpinner();
    }
    this.ui.requestRender();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const lines: string[] = [''];

    const header = this.renderHeader();
    const headerLines = new Text(header, 0, 0).render(contentWidth);
    for (let i = 0; i < headerLines.length; i += 1) {
      lines.push((i === 0 ? '' : MESSAGE_INDENT) + headerLines[i]!);
    }

    for (const worker of this.data.workers) {
      const icon = STATUS_ICONS[worker.status];
      const isActive = worker.status === 'running' || worker.status === 'pending';
      const runningIcon = worker.status === 'running' ? this.currentSpinnerFrame() + ' ' : '';
      const label = chalk.hex(this.colors.textDim)(`视角 ${worker.index + 1}`);
      const name = chalk.hex(this.colors.text)(worker.label);
      const workerLine = `${isActive ? runningIcon : ''}${icon} ${label} · ${name}`;
      const wrapped = new Text(workerLine, 0, 0).render(contentWidth);
      for (const line of wrapped) {
        lines.push(MESSAGE_INDENT + line);
      }
    }

    if (this.data.detail !== undefined && this.data.detail.length > 0) {
      const detail = chalk.hex(this.colors.textDim)(this.data.detail);
      const detailLines = new Text(detail, 0, 0).render(contentWidth);
      for (const line of detailLines) {
        lines.push(MESSAGE_INDENT + line);
      }
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private renderHeader(): string {
    const phase = this.data.phase;
    const { completedWorkers, totalWorkers, failedWorkers } = this.data;
    const tone = phase === 'failed' ? this.colors.error : this.colors.primary;
    const spinner = this.isTerminal(phase) ? '' : this.currentSpinnerFrame() + ' ';

    const summary = `融合计划 · ${completedWorkers}/${totalWorkers} 个视角`;
    const failedText = failedWorkers > 0 ? `（${failedWorkers} 失败）` : '';
    const phaseText = phase === 'planning'
      ? '规划中'
      : phase === 'synthesis'
        ? '完毕后将自动切换为 Plan 执行，当前融合中...'
        : phase === 'completed'
          ? '已完成'
          : '失败';

    return chalk.hex(tone)(`${spinner}${summary}${failedText} · ${phaseText}`);
  }

  private currentSpinnerFrame(): string {
    return BRAILLE_SPINNER_FRAMES[this.spinnerFrame % BRAILLE_SPINNER_FRAMES.length]!;
  }

  private startSpinner(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
      this.cachedWidth = undefined;
      this.cachedLines = undefined;
      this.ui.requestRender();
    }, BRAILLE_SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.intervalId === null) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  private isTerminal(phase: FusionPlanPhase): boolean {
    return phase === 'completed' || phase === 'failed';
  }
}
