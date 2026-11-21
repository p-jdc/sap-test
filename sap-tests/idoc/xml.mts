// IDoc-XML: the format of SAP's XML ports (WE21) and of the inbound service /sap/bc/idoc_xml. The structure is the
// same for every IDoc type:
//
//   <ORDERS05><IDOC BEGIN="1"><EDI_DC40 SEGMENT="1">…control fields…</EDI_DC40><E1EDK01 SEGMENT="1">…</E1EDK01>…
//
// One document can hold several IDocs of the same type. With "SOAP Protocol" ticked on the XML HTTP port, the
// same XML travels inside the Body of a SOAP envelope; parseIdocXml accepts both.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
	IdocError,
	idocTypeName,
	orderedControl,
	type Fields,
	type Idoc,
	type Segment
} from './idoc.mts';

export interface ParsedIdocXml {
	/** The root element: the IDoc type, or its extension for an extended IDoc. */
	root: string;
	/** Whether the IDocs came inside a SOAP envelope. */
	soap: boolean;
	idocs: Idoc[];
}

export interface WriteOptions {
	/** Wrap the IDoc-XML in a SOAP 1.1 envelope, as an XML HTTP port with "SOAP Protocol" does. */
	soap?: boolean;
	/** One element per line, indented with tabs. SAP sends it without; both read the same. */
	pretty?: boolean;
}

const SOAP_ENV = 'http://schemas.xmlsoap.org/soap/envelope/';

// Text stays as it is (no trimming, no number conversion: "0000000042" keeps its zeros). Comments and processing
// instructions are dropped, CDATA becomes text, namespace prefixes are removed. `htmlEntities` is what makes the
// parser decode numeric character references such as &#246;.
const parser = new XMLParser({
	preserveOrder: true,
	ignoreAttributes: false,
	attributeNamePrefix: '',
	removeNSPrefix: true,
	parseTagValue: false,
	parseAttributeValue: false,
	trimValues: false,
	ignoreDeclaration: true,
	ignorePiTags: true,
	htmlEntities: true
});

/** A node of the parser's ordered output: `{ TAG: children, ':@': attributes }` or `{ '#text': text }`. */
type XmlNode = Record<string, unknown>;

interface XmlElement {
	name: string;
	attributes: Record<string, string>;
	children: XmlNode[];
}

/** SAP writes the `/` of namespaced names (`/ABC/E1XYZ`) as `_-` in XML, since XML names can't contain `/`. */
const fromXmlName = (name: string) => name.replaceAll('_-', '/');
const toXmlName = (name: string) => name.replaceAll('/', '_-');

const isNode = (value: unknown): value is XmlNode =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The parser's nodes, checked: they come from a library, and the input from the network. */
function nodes(value: unknown): XmlNode[] {
	if (!Array.isArray(value) || !value.every(isNode))
		throw new IdocError('unexpected output from the XML parser');
	return value;
}

function asElement(node: XmlNode): XmlElement | undefined {
	const name = Object.keys(node).find((key) => key !== ':@' && key !== '#text');
	if (name === undefined) return undefined;
	const attributes = node[':@'];
	return {
		name,
		attributes: isNode(attributes)
			? Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, String(value)]))
			: {},
		children: nodes(node[name])
	};
}

/** The child elements. Text between them may only be whitespace (line breaks and indentation). */
function childElements(element: XmlElement): XmlElement[] {
	const result: XmlElement[] = [];
	for (const node of element.children) {
		const child = asElement(node);
		if (child) result.push(child);
		else if (String(node['#text']).trim() !== '')
			throw new IdocError(`<${element.name}> contains text where elements are expected`);
	}
	return result;
}

function textOf(element: XmlElement): string {
	let text = '';
	for (const node of element.children) {
		if (asElement(node)) throw new IdocError(`field <${element.name}> contains elements`);
		text += String(node['#text']);
	}
	return text;
}

function only(elements: XmlElement[], where: string): XmlElement {
	if (elements.length !== 1)
		throw new IdocError(`${where} must hold exactly one element, found ${elements.length}`);
	return elements[0];
}

/** A segment's children: elements marked SEGMENT or holding elements are segments, the others are fields. */
function readFields(element: XmlElement): { fields: Fields; children: Segment[] } {
	const fields: Fields = {};
	const children: Segment[] = [];
	for (const child of childElements(element)) {
		const isSegment =
			'SEGMENT' in child.attributes || child.children.some((node) => asElement(node) !== undefined);
		if (isSegment) {
			children.push({ name: fromXmlName(child.name), ...readFields(child) });
			continue;
		}
		const name = fromXmlName(child.name);
		if (name in fields) throw new IdocError(`field ${name} appears twice in <${element.name}>`);
		const value = textOf(child);
		if (value !== '') fields[name] = value;
	}
	return { fields, children };
}

function readIdoc(element: XmlElement): Idoc {
	const [control, ...segments] = childElements(element);
	if (control?.name !== 'EDI_DC40')
		throw new IdocError('an IDOC must start with its control record EDI_DC40');
	const { fields, children } = readFields(control);
	if (children.length > 0) throw new IdocError('the control record EDI_DC40 contains segments');
	return {
		control: fields,
		segments: segments.map((segment) => ({
			name: fromXmlName(segment.name),
			...readFields(segment)
		}))
	};
}

/** Reads IDoc-XML, plain or inside a SOAP envelope. Throws IdocError for anything that isn't IDoc-XML. */
export function parseIdocXml(xml: string): ParsedIdocXml {
	// IDoc-XML never has a DOCTYPE. Refusing it rules out entity expansion attacks on the mock hub's endpoint.
	if (/<!DOCTYPE/i.test(xml)) throw new IdocError('a DOCTYPE is not allowed in IDoc-XML');
	const valid = XMLValidator.validate(xml);
	if (valid !== true)
		throw new IdocError(`not well-formed XML: ${valid.err.msg} (line ${valid.err.line})`);

	let root = only(
		nodes(parser.parse(xml))
			.map(asElement)
			.filter((e) => e !== undefined),
		'the document'
	);
	let soap = false;
	if (root.name === 'Envelope') {
		soap = true;
		const body = childElements(root).find((child) => child.name === 'Body');
		if (!body) throw new IdocError('the SOAP envelope has no Body');
		root = only(childElements(body), 'the SOAP Body');
	}
	const idocs = childElements(root).map((element) => {
		if (element.name !== 'IDOC')
			throw new IdocError(`<${root.name}> may only hold IDOC elements, found <${element.name}>`);
		return readIdoc(element);
	});
	if (idocs.length === 0) throw new IdocError(`<${root.name}> holds no IDOC`);
	return { root: fromXmlName(root.name), soap, idocs };
}

// Characters XML 1.0 can't carry at all, not even escaped.
// oxlint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

function escapeText(value: string, field: string): string {
	if (INVALID_XML_CHARS.test(value))
		throw new IdocError(`field ${field} contains a control character XML can't carry`);
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function xmlName(name: string): string {
	const xml = toXmlName(name);
	if (!XML_NAME.test(xml)) throw new IdocError(`"${name}" can't be used as an XML element name`);
	return xml;
}

/** Writes IDocs as IDoc-XML. All IDocs of one document must have the same type. */
export function toIdocXml(idocs: Idoc | Idoc[], options: WriteOptions = {}): string {
	const list = Array.isArray(idocs) ? idocs : [idocs];
	if (list.length === 0) throw new IdocError('there is no IDoc to write');
	const root = idocTypeName(list[0]);
	for (const idoc of list)
		if (idocTypeName(idoc) !== root)
			throw new IdocError(
				`one document holds IDocs of one type: ${root} and ${idocTypeName(idoc)} are mixed`
			);

	const lines: string[] = [];
	const nl = options.pretty ? '\n' : '';
	const tab = (depth: number) => (options.pretty ? '\t'.repeat(depth) : '');
	const field = (depth: number, name: string, value: string) => {
		const tag = xmlName(name);
		lines.push(`${tab(depth)}<${tag}>${escapeText(value, name)}</${tag}>`);
	};
	const segment = (depth: number, s: Segment) => {
		const tag = xmlName(s.name);
		lines.push(`${tab(depth)}<${tag} SEGMENT="1">`);
		for (const [name, value] of Object.entries(s.fields))
			if (value !== '') field(depth + 1, name, value);
		for (const child of s.children) segment(depth + 1, child);
		lines.push(`${tab(depth)}</${tag}>`);
	};

	const base = options.soap ? 2 : 0;
	const rootTag = xmlName(root);
	lines.push(`${tab(base)}<${rootTag}>`);
	for (const idoc of list) {
		lines.push(`${tab(base + 1)}<IDOC BEGIN="1">`, `${tab(base + 2)}<EDI_DC40 SEGMENT="1">`);
		for (const [name, value] of orderedControl(idoc.control)) field(base + 3, name, value);
		lines.push(`${tab(base + 2)}</EDI_DC40>`);
		for (const s of idoc.segments) segment(base + 2, s);
		lines.push(`${tab(base + 1)}</IDOC>`);
	}
	lines.push(`${tab(base)}</${rootTag}>`);

	const body = options.soap
		? [
				`<soapenv:Envelope xmlns:soapenv="${SOAP_ENV}">`,
				`${tab(1)}<soapenv:Header/>`,
				`${tab(1)}<soapenv:Body>`,
				...lines,
				`${tab(1)}</soapenv:Body>`,
				'</soapenv:Envelope>'
			]
		: lines;
	return `<?xml version="1.0" encoding="UTF-8"?>${nl}${body.join(nl)}${nl}`;
}
