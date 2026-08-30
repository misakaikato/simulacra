export const sha256Hex = (input: string | Uint8Array): string => {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return hasher.digest("hex");
};

const canonicalize = (value: unknown, out: string[]): void => {
	if (value === null || value === undefined) {
		out.push("null");
		return;
	}
	switch (typeof value) {
		case "boolean":
		case "number":
		case "string":
			out.push(JSON.stringify(value));
			return;
		case "object":
			break;
		default:
			throw new TypeError(`value of type ${typeof value} is not JSON-serializable`);
	}
	if (Array.isArray(value)) {
		out.push("[");
		value.forEach((item: unknown, i) => {
			if (i > 0) out.push(",");
			canonicalize(item, out);
		});
		out.push("]");
		return;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record)
		.filter((k) => record[k] !== undefined)
		.sort();
	out.push("{");
	keys.forEach((k, i) => {
		if (i > 0) out.push(",");
		out.push(JSON.stringify(k), ":");
		canonicalize(record[k], out);
	});
	out.push("}");
};

export const canonicalJson = (value: unknown): string => {
	const out: string[] = [];
	canonicalize(value, out);
	return out.join("");
};

export const hashOf = (value: unknown): string => sha256Hex(canonicalJson(value));
