import type { FlowStep, RunTest, StepStatus } from './types';

export type StepOverlay = { status: StepStatus; duration: number; error?: string; calls: string[] };

/**
 * Maps a run's reporter steps onto the statically parsed flow steps by source line.
 * Steps reported from helper files (e.g. runTransaction in helpers/) carry no spec line, so they
 * are attributed to the next helper-call step after the last matched one.
 */
export function overlaySteps(
	steps: FlowStep[],
	run: RunTest | undefined
): Record<string, StepOverlay> {
	const out: Record<string, StepOverlay> = {};
	if (!run) return out;
	for (const s of steps)
		out[s.id] = {
			status: run.status === 'skipped' ? 'skipped' : 'pending',
			duration: 0,
			calls: []
		};
	if (run.status === 'skipped') return out;

	const byLine = (line: number) => steps.findIndex((s) => line >= s.line && line <= s.endLine);
	const mapped = new Map<string, number>();
	let pointer = -1;
	let inHelper = false;

	for (const rs of run.steps) {
		let idx = -1;
		const outside = rs.file === undefined && rs.line !== undefined;
		if (rs.file === run.file && rs.line) {
			idx = byLine(rs.line);
		} else if (outside) {
			// Consecutive calls from helper files belong to the same helper step. Two helper steps in a
			// row cannot be told apart this way, so their calls merge into the first.
			if (inHelper && steps[pointer]?.kind === 'helper') idx = pointer;
			else if (steps[pointer + 1]?.kind === 'helper') idx = pointer + 1;
		}
		if (rs.line !== undefined) inHelper = outside && idx >= 0;
		if (idx < 0) continue;
		pointer = Math.max(pointer, idx);
		mapped.set(rs.stepId, idx);
		const o = out[steps[idx].id];
		o.calls.push(rs.title);
		const nestedInSame = rs.parentId !== undefined && mapped.get(rs.parentId) === idx;
		if (rs.duration !== undefined && !nestedInSame) o.duration += rs.duration;
		if (rs.error) {
			o.status = 'failed';
			o.error ??= rs.error;
		} else if (o.status !== 'failed') {
			o.status =
				rs.duration === undefined
					? 'running'
					: o.status === 'running' && !nestedInSame
						? 'running'
						: 'passed';
		}
	}
	// A step whose last call finished is passed even if an earlier call left it marked running.
	for (const rs of run.steps) {
		const idx = mapped.get(rs.stepId);
		if (idx === undefined) continue;
		const o = out[steps[idx].id];
		const open = run.steps.some((x) => mapped.get(x.stepId) === idx && x.duration === undefined);
		if (o.status === 'running' && !open) o.status = 'passed';
	}

	if (run.status && run.status !== 'passed') {
		let failIdx = run.error?.line && run.error.file === run.file ? byLine(run.error.line) : -1;
		if (failIdx < 0) failIdx = steps.findIndex((s) => out[s.id].status === 'running');
		if (failIdx < 0) failIdx = Math.max(pointer, 0);
		if (steps[failIdx]) {
			const o = out[steps[failIdx].id];
			o.status = 'failed';
			o.error ??= run.error?.message;
		}
		for (let i = failIdx + 1; i < steps.length; i++) {
			if (out[steps[i].id].status === 'pending') out[steps[i].id].status = 'skipped';
		}
	}
	if (run.status) {
		for (const s of steps)
			if (out[s.id].status === 'running')
				out[s.id].status = run.status === 'passed' ? 'passed' : 'failed';
	}
	return out;
}
