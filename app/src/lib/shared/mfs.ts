// What the MFS PLC emulator (sap-tests/mfs) reports over its control API, checked on arrival: the emulator is
// a separate process (later a separate service), so its answers are outside data like any other.
import { z } from 'zod';

const Position = z.object({ x: z.number(), y: z.number() });

export const MfsSetupSchema = z.object({
	name: z.string(),
	description: z.string(),
	interfaceType: z.string(),
	ewm: z.string(),
	plcs: z.array(z.object({ id: z.string(), description: z.string() })),
	points: z.array(z.object({ id: z.string(), role: z.string() })),
	devices: z.array(
		z.object({
			id: z.string(),
			type: z.string(),
			plc: z.string(),
			from: z.string().optional(),
			to: z.string().optional(),
			point: z.string().optional(),
			stops: z.array(z.string()).optional(),
			aisle: z.string().optional(),
			infeed: z.string().optional(),
			outfeed: z.string().optional(),
			stacks: z.number().optional(),
			levels: z.number().optional(),
			automatic: z.boolean().optional()
		})
	),
	view: z
		.object({
			width: z.number(),
			height: z.number(),
			points: z.record(z.string(), Position),
			racks: z.record(z.string(), Position),
			rails: z.record(z.string(), z.object({ y: z.number() })).optional()
		})
		.optional()
});

const MfsHuSchema = z.object({
	hu: z.string(),
	at: z.string().optional(),
	moving: z.object({ device: z.string(), src: z.string(), dst: z.string() }).optional(),
	left: z.boolean(),
	script: z.object({ idPoint: z.string().optional(), binOccupied: z.boolean().optional() }),
	path: z.array(z.string())
});

export const MfsStateSchema = z.object({
	setup: z.string(),
	plcs: z.array(
		z.object({
			id: z.string(),
			port: z.number(),
			connected: z.boolean(),
			lastLifeAt: z.number(),
			faults: z.object({ dropAcks: z.number().optional(), stopLife: z.boolean().optional() })
		})
	),
	devices: z.array(
		z.object({
			id: z.string(),
			type: z.string(),
			plc: z.string(),
			status: z.enum(['UP', 'DOWN']),
			active: z.number(),
			queued: z.number()
		})
	),
	hus: z.array(MfsHuSchema)
});

export const MfsTelegramSchema = z.object({
	n: z.number(),
	at: z.number(),
	channel: z.string(),
	from: z.string(),
	to: z.string(),
	type: z.string(),
	seq: z.string(),
	fields: z.record(z.string(), z.string()),
	note: z.string().optional(),
	/** Acknowledgements and life telegrams. */
	technical: z.boolean().optional()
});

export const MfsEventSchema = z.object({
	n: z.number(),
	at: z.number(),
	text: z.string(),
	hu: z.string().optional(),
	device: z.string().optional()
});

export const EwmStateSchema = z.object({
	hus: z.array(
		z.object({
			hu: z.string(),
			status: z.string(),
			location: z.string(),
			bin: z.string().optional(),
			path: z.array(z.string()),
			scan: z.string().optional(),
			error: z.string().optional()
		})
	),
	tasks: z.array(
		z.object({
			tanum: z.string(),
			hu: z.string(),
			src: z.string(),
			dst: z.string(),
			plc: z.string(),
			status: z.string(),
			result: z.string().optional()
		})
	)
});

/** A scenario as listed for choosing: from the scenario files, or from the running Mock PLC. */
export const MfsScenarioInfoSchema = z.object({
	name: z.string(),
	title: z.string(),
	description: z.string(),
	setup: z.string(),
	modes: z.array(z.enum(['demo', 'ewm'])),
	/** Reference errors against the running setup (only when listed by the Mock PLC). */
	problems: z.array(z.string()).optional()
});

export const MfsScenarioRunSchema = z.object({
	scenario: z.string(),
	title: z.string(),
	status: z.enum(['running', 'paused', 'passed', 'failed', 'stopped']),
	steps: z.array(
		z.object({
			title: z.string(),
			status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
			detail: z.string().optional()
		})
	),
	checks: z.array(z.object({ title: z.string(), ok: z.boolean(), detail: z.string().optional() })),
	hus: z.record(z.string(), z.string()),
	startedAt: z.string(),
	finishedAt: z.string().optional(),
	error: z.string().optional()
});

export type MfsScenarioInfo = z.infer<typeof MfsScenarioInfoSchema>;
export type MfsScenarioRun = z.infer<typeof MfsScenarioRunSchema>;
export type MfsSetup = z.infer<typeof MfsSetupSchema>;
export type MfsState = z.infer<typeof MfsStateSchema>;
export type MfsTelegram = z.infer<typeof MfsTelegramSchema>;
export type MfsEvent = z.infer<typeof MfsEventSchema>;
type EwmState = z.infer<typeof EwmStateSchema>;

/** `demo`: the fake EWM runs inside the emulator. `ewm`: the emulator waits for a real EWM to connect. */
export type MfsMode = 'demo' | 'ewm';

export type MfsStatus = {
	running: boolean;
	/** Started elsewhere (MFS_EMULATOR_URL): the app only watches and controls it. */
	external: boolean;
	setup?: string;
	mode?: MfsMode;
	speed?: number;
	startedAt?: string;
	/** Why the last start failed or the emulator stopped unexpectedly. */
	error?: string;
};

/** One live update for the MFS page. */
export type MfsSnapshot = {
	status: MfsStatus;
	setup?: MfsSetup;
	state?: MfsState;
	ewm?: EwmState;
	/** The scenarios the running Mock PLC can run, and the current or last scenario run. */
	scenarios?: MfsScenarioInfo[];
	run?: MfsScenarioRun | null;
	telegrams: MfsTelegram[];
	events: MfsEvent[];
};
