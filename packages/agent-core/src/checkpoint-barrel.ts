/**
 * Barrel for @scream-code/agent-core/checkpoint.
 *
 * Re-exports checkpoint from loop/turn-step for lazy-loaded commands (rewind.ts).
 * Not imported by footer.ts — that uses the lightweight turn-step barrel instead.
 */
export { checkpoint } from './loop/turn-step';
