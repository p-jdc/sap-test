// A telegram layout that differs from the DEMO layout in everything a layout can decide: other telegram and
// field names, numeric result codes, a six-digit sequence number, no start and end characters with one fixed
// telegram length, and acknowledgement by sending the telegram back. Made up, like the DEMO layout: it shows that
// the Mock PLC takes these things from the layout file and not from its code.
import { TelegramLayoutSchema } from '../../mfs/telegram.mts';

export const foreign = {
	interfaceType: 'FOREIGN',
	fill: '.',
	length: 90,
	header: [
		{ name: 'TELETYPE', length: 6 },
		{ name: 'SEQU_NO', length: 6, type: 'numc' },
		{ name: 'SENDER', length: 8 },
		{ name: 'RECEIVER', length: 8 },
		{ name: 'HANDSHAKE', length: 1 }
	],
	telegrams: {
		ALIVE: [],
		TORDER: [
			{ name: 'SOURCE', length: 18 },
			{ name: 'DEST', length: 18 },
			{ name: 'HUIDENT', length: 20 }
		],
		TCONF: [
			{ name: 'SOURCE', length: 18 },
			{ name: 'DEST', length: 18 },
			{ name: 'HUIDENT', length: 20 },
			{ name: 'ERROR', length: 2 }
		],
		SCANNR: [
			{ name: 'CP', length: 18 },
			{ name: 'HUIDENT', length: 20 },
			{ name: 'ERROR', length: 2 }
		]
	},
	roles: {
		senderField: 'SENDER',
		receiverField: 'RECEIVER',
		seqField: 'SEQU_NO',
		typeField: 'TELETYPE',
		life: 'ALIVE'
	},
	handshake: { mode: 'echo', field: 'HANDSHAKE', request: 'R', confirm: 'A' },
	messages: {
		// Tasks carry no task number here, and there is no status telegram.
		task: {
			type: 'TORDER',
			fields: { source: 'SOURCE', destination: 'DEST', hu: 'HUIDENT' },
			codes: {}
		},
		confirmation: {
			type: 'TCONF',
			fields: { source: 'SOURCE', destination: 'DEST', hu: 'HUIDENT', result: 'ERROR' },
			codes: { ok: '00', error: '99', occupied: '21' }
		},
		scan: {
			type: 'SCANNR',
			fields: { point: 'CP', hu: 'HUIDENT', result: 'ERROR' },
			codes: { ok: '00', error: '99', noRead: '11' }
		}
	}
};

export const foreignLayout = TelegramLayoutSchema.parse(foreign);
