/**
 * Reads the VBScript of a UFT action (Action<n>/Script.mts) far enough to translate it: the logical
 * statements with their line numbers, which control-flow block each one is in, `With` blocks
 * resolved, and each statement parsed into an object chain, a method and its arguments. Not a full
 * VBScript parser: what it does not understand comes back as `other`, and the translation keeps
 * such statements as comments for a person.
 */

/** One logical statement: continuation lines joined, comments and `:` separators taken apart. */
export interface Line {
	/** 1-based line of the script where the statement starts. */
	line: number;
	/** The statement as it is written, `With` not resolved: for the comment in the test file. */
	source: string;
	/** The statement with the object of the enclosing `With` blocks put in front of a leading dot. */
	text: string;
	/**
	 * The control-flow blocks around the statement (If, For, Do, While, Select, Function, Sub), the
	 * outermost first. A statement inside one runs only sometimes or several times: the translation
	 * does not turn it into a plain line of code.
	 */
	blocks: string[];
	/** The statement opens or closes a block (If … Then, End If, Next, …), or is a declaration. */
	structure?: boolean;
	/** A comment line of the script (`'` or `Rem`), without the marker. */
	comment?: string;
}

const BLOCK_OPEN: [RegExp, string][] = [
	[/^if\b.*\bthen$/i, 'If'],
	[/^select\s+case\b/i, 'Select'],
	[/^for\b/i, 'For'],
	[/^do\b/i, 'Do'],
	[/^while\b/i, 'While'],
	[/^(?:(?:public|private)\s+)?(?:function|sub)\b/i, 'Function'],
	[/^class\b/i, 'Class']
];
const BLOCK_CLOSE = /^(?:end\s+(?:if|select|function|sub|class)|next\b|loop\b|wend\b)/i;
const BLOCK_MIDDLE = /^(?:else(?:if\b.*)?|case\b.*)$/i;
const DECLARATION = /^(?:option\s+explicit|dim\b|redim\b|const\b|private\s+\w+$|public\s+\w+$)/i;

/** Splits off a comment and the `:` separators outside of strings. */
function splitPhysical(text: string): { parts: string[]; comment?: string } {
	const parts: string[] = [];
	let current = '';
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i] ?? '';
		if (c === '"') {
			inString = !inString;
			current += c;
			continue;
		}
		if (!inString && c === "'") {
			parts.push(current);
			return { parts, comment: text.slice(i + 1) };
		}
		if (!inString && /^rem(\s|$)/i.test(text.slice(i)) && current.trim() === '') {
			parts.push(current);
			return { parts, comment: text.slice(i + 3) };
		}
		if (!inString && c === ':' && text[i + 1] !== '=') {
			parts.push(current);
			current = '';
			continue;
		}
		current += c;
	}
	parts.push(current);
	return { parts };
}

/** A physical line that ends in ` _` outside a string continues on the next one. */
function continues(text: string): boolean {
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') inString = !inString;
		else if (!inString && c === "'") return false;
	}
	return !inString && /(?:^|\s)_\s*$/.test(text);
}

/** The logical statements of a script. */
export function scriptLines(script: string): Line[] {
	const physical = script.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
	const out: Line[] = [];
	const blocks: string[] = [];
	const withs: string[] = [];
	for (let i = 0; i < physical.length; i++) {
		const start = i + 1;
		let text = physical[i] ?? '';
		while (continues(text) && i + 1 < physical.length) {
			text = text.replace(/\s_\s*$|^_\s*$/, ' ') + (physical[++i] ?? '').trim();
		}
		const { parts, comment } = splitPhysical(text);
		for (const part of parts) {
			const source = part.trim();
			if (!source) continue;
			const resolved = resolveWith(source, withs);
			if (/^with\s+/i.test(source)) {
				withs.push(resolved.replace(/^with\s+/i, '').trim());
				out.push({ line: start, source, text: resolved, blocks: [...blocks], structure: true });
				continue;
			}
			if (/^end\s+with$/i.test(source)) {
				withs.pop();
				out.push({ line: start, source, text: source, blocks: [...blocks], structure: true });
				continue;
			}
			if (BLOCK_CLOSE.test(source)) {
				blocks.pop();
				out.push({ line: start, source, text: source, blocks: [...blocks], structure: true });
				continue;
			}
			if (BLOCK_MIDDLE.test(source)) {
				out.push({
					line: start,
					source,
					text: resolved,
					blocks: blocks.slice(0, -1),
					structure: true
				});
				continue;
			}
			const opened = BLOCK_OPEN.find(([re]) => re.test(source))?.[1];
			if (opened) {
				out.push({ line: start, source, text: resolved, blocks: [...blocks], structure: true });
				blocks.push(opened);
				continue;
			}
			const line: Line = { line: start, source, text: resolved, blocks: [...blocks] };
			if (DECLARATION.test(source)) line.structure = true;
			// A one-line If (`If x Then y`) runs `y` only sometimes.
			if (/^if\b.*\bthen\b\s*\S/i.test(source)) line.blocks = [...blocks, 'If'];
			out.push(line);
		}
		if (comment !== undefined && parts.every((p) => p.trim() === ''))
			out.push({
				line: start,
				source: `'${comment}`,
				text: '',
				blocks: [...blocks],
				comment: comment.trim()
			});
	}
	return out;
}

/** Puts the object of the innermost `With` in front of a statement that starts with a dot. */
function resolveWith(text: string, withs: string[]): string {
	const object = withs.at(-1);
	if (!object) return text;
	// `.Foo` at the start, and `= .Foo` or `(.Foo` inside (a value read from the With object).
	return text.replaceAll(/(^|[\s(,=&+-])\.(?=[A-Za-z_])/g, `$1${object}.`);
}

// ---- Expressions -------------------------------------------------------------------------------

type Token =
	| { t: 'name'; v: string }
	| { t: 'string'; v: string }
	| { t: 'number'; v: string }
	| { t: 'punct'; v: string };

function tokenize(text: string): Token[] | undefined {
	const tokens: Token[] = [];
	let i = 0;
	while (i < text.length) {
		const c = text[i] ?? '';
		if (/\s/.test(c)) {
			i++;
		} else if (c === '"') {
			let value = '';
			i++;
			for (;;) {
				if (i >= text.length) return undefined;
				if (text[i] === '"') {
					if (text[i + 1] === '"') {
						value += '"';
						i += 2;
						continue;
					}
					i++;
					break;
				}
				value += text[i++];
			}
			tokens.push({ t: 'string', v: value });
		} else if (/[A-Za-z_]/.test(c)) {
			const m = /^[A-Za-z_]\w*/.exec(text.slice(i))?.[0] ?? c;
			tokens.push({ t: 'name', v: m });
			i += m.length;
		} else if (/\d/.test(c)) {
			const m = /^\d+(?:\.\d+)?/.exec(text.slice(i))?.[0] ?? c;
			tokens.push({ t: 'number', v: m });
			i += m.length;
		} else if (c === '[') {
			// A bracketed identifier, e.g. RunAction's "[Test]": rare outside strings.
			const end = text.indexOf(']', i);
			if (end < 0) return undefined;
			tokens.push({ t: 'name', v: text.slice(i + 1, end) });
			i = end + 1;
		} else {
			const two = text.slice(i, i + 2);
			if (['<>', '<=', '>='].includes(two)) {
				tokens.push({ t: 'punct', v: two });
				i += 2;
			} else {
				tokens.push({ t: 'punct', v: c });
				i++;
			}
		}
	}
	return tokens;
}

/** One part of an object chain or property path: `SAPGuiEdit("Name")`, `.Set`, `DataTable("x", 1)`. */
export interface Segment {
	name: string;
	/** Undefined without parentheses. */
	args?: Expr[];
}

export type Expr =
	| { kind: 'string'; value: string }
	| { kind: 'number'; value: string }
	| { kind: 'path'; segments: Segment[] }
	| { kind: 'concat'; parts: Expr[] }
	| { kind: 'other'; text: string };

class Parser {
	private i = 0;
	constructor(private readonly tokens: Token[]) {}

	done() {
		return this.i >= this.tokens.length;
	}
	peek(): Token | undefined {
		return this.tokens[this.i];
	}
	isPunct(v: string) {
		const t = this.peek();
		return t?.t === 'punct' && t.v === v;
	}
	take() {
		return this.tokens[this.i++];
	}

	/** A value: a string, a number, a path, joined with & or +. Stops at `,`, `)` and comparisons. */
	expr(): Expr | undefined {
		const parts: Expr[] = [];
		for (;;) {
			const part = this.primary();
			if (!part) return undefined;
			parts.push(part);
			if (this.isPunct('&') || this.isPunct('+')) {
				this.take();
				continue;
			}
			break;
		}
		return parts.length === 1 ? parts[0] : { kind: 'concat', parts };
	}

	primary(): Expr | undefined {
		const t = this.peek();
		if (!t) return undefined;
		if (t.t === 'string') {
			this.take();
			return { kind: 'string', value: t.v };
		}
		if (t.t === 'number') {
			this.take();
			return { kind: 'number', value: t.v };
		}
		if (t.t === 'punct' && t.v === '-' && this.tokens[this.i + 1]?.t === 'number') {
			this.take();
			const n = this.take();
			return { kind: 'number', value: `-${n?.v ?? ''}` };
		}
		if (t.t === 'punct' && t.v === '(') {
			this.take();
			const inner = this.expr();
			if (!inner || !this.isPunct(')')) return undefined;
			this.take();
			return inner;
		}
		if (t.t === 'name') return this.path();
		return undefined;
	}

	path(): Expr | undefined {
		const segments: Segment[] = [];
		for (;;) {
			const name = this.take();
			if (name?.t !== 'name') return undefined;
			const segment: Segment = { name: name.v };
			if (this.isPunct('(')) {
				this.take();
				const args = this.args(')');
				if (!args) return undefined;
				segment.args = args;
			}
			segments.push(segment);
			if (this.isPunct('.') && this.tokens[this.i + 1]?.t === 'name') {
				this.take();
				continue;
			}
			return { kind: 'path', segments };
		}
	}

	/** Comma-separated values up to `close` (taken), or to the end when `close` is undefined. */
	args(close?: string): Expr[] | undefined {
		const args: Expr[] = [];
		if (close && this.isPunct(close)) {
			this.take();
			return args;
		}
		for (;;) {
			const value = this.expr();
			if (!value) return undefined;
			args.push(value);
			if (this.isPunct(',')) {
				this.take();
				continue;
			}
			if (close) {
				if (!this.isPunct(close)) return undefined;
				this.take();
			} else if (!this.done()) return undefined;
			return args;
		}
	}
}

export type Statement =
	/** `Obj("a").Obj("b").Method args`, also `Call …(…)` and a bare `Wait 2`. */
	| { kind: 'call'; segments: Segment[]; method: string; args: Expr[] }
	/** `x = value` and `Set x = value`. */
	| { kind: 'assign'; target: string; value: Expr }
	| { kind: 'other' };

/** Parses one statement (the `text` of a Line). */
export function parseStatement(text: string): Statement {
	const tokens = tokenize(text);
	if (!tokens || tokens.length === 0) return { kind: 'other' };
	let start = 0;
	const first = tokens[0];
	if (first?.t === 'name' && /^(call|set)$/i.test(first.v)) start = 1;
	const p = new Parser(tokens.slice(start));
	const head = p.path();
	if (head?.kind !== 'path') return { kind: 'other' };
	if (p.isPunct('=')) {
		p.take();
		const value = p.expr();
		if (!value || !p.done() || head.segments.length !== 1 || head.segments[0]?.args)
			return { kind: 'other' };
		return { kind: 'assign', target: head.segments[0]?.name ?? '', value };
	}
	const segments = [...head.segments];
	const last = segments.pop();
	if (!last) return { kind: 'other' };
	let args: Expr[];
	if (last.args && p.done()) {
		args = last.args;
	} else {
		if (last.args) return { kind: 'other' };
		const rest = p.done() ? [] : p.args();
		if (!rest) return { kind: 'other' };
		args = rest;
	}
	return { kind: 'call', segments, method: last.name, args };
}

/** The text of a string or number argument, undefined for anything else. */
export function literal(expr: Expr | undefined): string | undefined {
	if (expr?.kind === 'string' || expr?.kind === 'number') return expr.value;
	return undefined;
}

/** The single name of a path without arguments (`ENTER`, `micPass`, `dtGlobalSheet`). */
export function bareName(expr: Expr | undefined): string | undefined {
	if (expr?.kind !== 'path' || expr.segments.length !== 1) return undefined;
	const [only] = expr.segments;
	return only && !only.args ? only.name : undefined;
}
