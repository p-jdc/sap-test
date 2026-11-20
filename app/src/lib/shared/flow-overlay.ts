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
	if (!run) return {};
	const fresh = (): StepOverlay => ({
		status: run.status === 'skipped' ? 'skipped' : 'pending',
		duration: 0,
		calls: []
	});
	const entries = steps.map((s) => ({ id: s.id, overlay: fresh() }));
	// One overlay per step, index-aligned with `steps`.
	const overlays = entries.map((e) => e.overlay);
	const result = (): Record<string, StepOverlay> =>
		Object.fromEntries(entries.map((e) => [e.id, e.overlay]));
	if (run.status === 'skipped') return result();

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
		const o = overlays[idx];
		if (!o) continue;
		pointer = Math.max(pointer, idx);
		mapped.set(rs.stepId, idx);
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
		const o = idx === undefined ? undefined : overlays[idx];
		if (!o) continue;
		const open = run.steps.some((x) => mapped.get(x.stepId) === idx && x.duration === undefined);
		if (o.status === 'running' && !open) o.status = 'passed';
	}

	if (run.status && run.status !== 'passed') {
		let failIdx = run.error?.line && run.error.file === run.file ? byLine(run.error.line) : -1;
		if (failIdx < 0) failIdx = overlays.findIndex((o) => o.status === 'running');
		if (failIdx < 0) failIdx = Math.max(pointer, 0);
		const failed = overlays[failIdx];
		if (failed) {
			failed.status = 'failed';
			failed.error ??= run.error?.message;
		}
		for (const o of overlays.slice(failIdx + 1)) {
			if (o.status === 'pending') o.status = 'skipped';
		}
	}
	if (run.status) {
		for (const o of overlays)
			if (o.status === 'running') o.status = run.status === 'passed' ? 'passed' : 'failed';
	}
	return result();
}
