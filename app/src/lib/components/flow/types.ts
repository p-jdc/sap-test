import type { StepOverlay } from '#lib/shared/flow-overlay.js';
import type { FlowStep } from '#lib/shared/types.js';

export type StepNodeData = { step: FlowStep; overlay?: StepOverlay };
export type TerminalNodeData = { label: string; sub?: string; status?: string };
