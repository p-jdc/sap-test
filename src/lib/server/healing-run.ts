// The run the healer is working on, for the retention rules: they leave its files alone until the
// session ends. A module of its own, since the healer itself depends on the run store.
let current: string | null = null;

export function setHealingRun(runId: string | null) {
	current = runId;
}

export const healingRun = () => current;
