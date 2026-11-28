import { XMLParser } from 'fast-xml-parser';

/**
 * Object repositories of UFT exported as XML (Object Repository Manager: File › Export to XML; the
 * format of `qtpRep:ObjectRepository`). The binary ones (ObjectRepository.bdb, *.tsr) cannot be
 * read: without their XML a script only gives the logical names of its objects, and the
 * translation then has to rely on descriptive properties in the script itself.
 */

/** The properties of one test object, by lower-case name (`name`, `guicomponenttype`, `id`, …). */
export type Properties = Record<string, string>;

/** One object of a repository: its class, logical name and properties. */
interface RepoObject {
	className: string;
	name: string;
	properties: Properties;
	/** Properties whose value is a regular expression, not the value itself. */
	patterns: string[];
}

/**
 * The objects of one or more repositories, by the chain of logical names as a script writes it:
 * `SAPGuiSession("Session").SAPGuiWindow("SAP Easy Access").SAPGuiEdit("Order Type")` has the key
 * `sapguisession:session/sapguiwindow:sap easy access/sapguiedit:order type`.
 */
export type Repository = Map<string, RepoObject>;

export const objectKey = (chain: { className: string; name: string }[]) =>
	chain.map((c) => `${c.className.toLowerCase()}:${c.name.toLowerCase()}`).join('/');

// Values stay text: "0" and "1" are property values, not numbers. The parser refuses external
// entities; numeric character references (&#246;) are decoded below.
const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@',
	removeNSPrefix: true,
	isArray: (name) => ['Object', 'Property', 'Value'].includes(name),
	parseTagValue: false,
	parseAttributeValue: false,
	ignoreDeclaration: true,
	ignorePiTags: true
});

/** An element of the parser's output: its attributes (`@Name`), children and `#text`. */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the XML parser's own output shape, read through the checks below
type XmlNode = Record<string, unknown>;

const isNode = (value: unknown): value is XmlNode =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const child = (node: XmlNode | undefined, name: string): XmlNode | undefined => {
	const value = node?.[name];
	return isNode(value) ? value : undefined;
};
const children = (node: XmlNode | undefined, name: string): XmlNode[] => {
	const value = node?.[name];
	return Array.isArray(value) ? value.filter((v) => isNode(v)) : [];
};
const attribute = (node: XmlNode, name: string): string => {
	const value = node[`@${name}`];
	return typeof value === 'string' ? value : '';
};
const text = (node: XmlNode | undefined): string => {
	const value = node?.['#text'];
	if (typeof value !== 'string') return '';
	return value.replaceAll(/&#(x[0-9a-f]+|\d+);/gi, (ref, code: string) => {
		const point =
			code.startsWith('x') || code.startsWith('X')
				? Number.parseInt(code.slice(1), 16)
				: Number(code);
		return point > 0 && point <= 0x10_ffff ? String.fromCodePoint(point) : ref;
	});
};

function properties(node: XmlNode): { properties: Properties; patterns: string[] } {
	const props: Properties = {};
	const patterns: string[] = [];
	for (const p of children(child(node, 'Properties'), 'Property')) {
		const name = attribute(p, 'Name').toLowerCase();
		if (!name) continue;
		const value = children(p, 'Value')[0];
		props[name] = text(value);
		if (value && attribute(value, 'RegularExpression') === '1') patterns.push(name);
	}
	return { properties: props, patterns };
}

/** Whether the file is an exported object repository, before parsing all of it. */
export const isRepositoryXml = (xml: string) =>
	/<(?:\w+:)?ObjectRepository[\s>]/.test(xml.slice(0, 4000));

/** Adds the objects of one exported repository to `into`. Throws on a file that is not one. */
export function readRepository(xml: string, into: Repository = new Map()): Repository {
	const parsed: unknown = parser.parse(xml);
	const root = isNode(parsed) ? child(parsed, 'ObjectRepository') : undefined;
	if (!root) throw new Error('not an exported UFT object repository (no ObjectRepository element)');
	const walk = (nodes: XmlNode[], chain: { className: string; name: string }[]) => {
		for (const node of nodes) {
			const className = attribute(node, 'Class');
			const name = attribute(node, 'Name');
			if (!className) continue;
			const here = [...chain, { className, name }];
			const key = objectKey(here);
			// A test's own repository is read before the shared ones and wins.
			if (!into.has(key)) into.set(key, { className, name, ...properties(node) });
			walk(children(child(node, 'ChildObjects'), 'Object'), here);
		}
	};
	walk(children(child(root, 'Objects'), 'Object'), []);
	return into;
}

/**
 * The properties of a descriptive-programming argument: `"name:=VBAK-AUART"`, several of them as
 * arguments of one call. Undefined when the argument is a logical name.
 */
export function descriptive(
	args: string[]
): { properties: Properties; patterns: string[] } | undefined {
	if (args.length === 0 || !args.every((a) => a.includes(':='))) return undefined;
	const props: Properties = {};
	const patterns: string[] = [];
	for (const arg of args) {
		const at = arg.indexOf(':=');
		const name = arg.slice(0, at).trim().toLowerCase();
		// UFT reads descriptive values as regular expressions. Escaped brackets (btn\[8\]) and dots
		// are plain text; anything else that is special makes it a pattern.
		const raw = arg.slice(at + 2);
		const plain = raw.replaceAll(/\\([[\].()])/g, '$1');
		props[name] = plain;
		if (/[*+?^$|{}]/.test(raw.replaceAll(/\\./g, ''))) patterns.push(name);
	}
	return { properties: props, patterns };
}
