/**
 * Reads the body, giving up as soon as more than `limit` bytes have arrived (a body with no Content-Length, or a
 * false one). Returns null when it is too large; the unread rest of the stream is cancelled.
 */
export async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
	if (request.body === null) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

/** True when a Content-Length header is present and already over `limit`. */
export function declaredTooLarge(request: Request, limit: number): boolean {
	const header = request.headers.get("Content-Length");
	return header !== null && Number(header) > limit;
}
