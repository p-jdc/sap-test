// The run the healer is working on, for the retention rules: they leave its files alone until the
// session ends. A module of its own, since the healer itself depends on the run store.
let current: string | null = null;

export function setHealingRun(runId: string | null) {
	current = runId;
}

export const healingRun = () => current;

// The flow the planner is exploring (planner.ts), for the healer and the runs: one AI session at a
// time, and none beside a run. Here for the same reason: the planner depends on the healer.
let plan: string | null = null;

export function setPlanning(flow: string | null) {
	plan = flow;
}

/** Why nothing else may use the browser now, if the planner is working. */
export const planningBlock = () =>
	plan === null ? undefined : 'The planner is exploring an application. Wait or stop it first.';
