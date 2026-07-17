/**
 * Barrel for @scream-code/agent-core/turn-step — lightweight, zero loop/ dependency.
 *
 * Only exports maskingStats for eager TUI footer consumption.
 * checkpoint has its own barrel (checkpoint-barrel) for lazy import by commands/rewind.ts.
 */
export { maskingStats } from './utils/masking-stats';
