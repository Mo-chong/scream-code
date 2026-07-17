/**
 * Barrel export for the session-wide CheckpointManager singleton.
 * Import this from the TUI layer to wire /rewind and /forward commands.
 */
export { checkpoint } from './loop/turn-step';
