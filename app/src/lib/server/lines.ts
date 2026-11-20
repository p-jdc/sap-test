/**
 * Turns a stream of text chunks into whole lines. A chunk can end in the middle of a line, so the
 * rest is kept until the next chunk; `flush` hands out a last line that has no newline.
 */
export function lineSplitter(onLine: (line: string) => void) {
	let buffer = '';
	return {
		push(chunk: string) {
			buffer += chunk;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) onLine(line);
		},
		flush() {
			if (buffer) onLine(buffer);
			buffer = '';
		}
	};
}
