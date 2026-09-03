// Canonical JSON and sha256 for every hash the kernel takes: keys sorted, undefined dropped,
// no whitespace, so equal values hash identically across runs, processes and platforms.
// 内核所有哈希共用的规范化 JSON 与 sha256：键排序、丢弃 undefined、无空白，相同的值在任何运行、进程与
// 平台上哈希一致。

export const sha256Hex = (input: string | Uint8Array): string => {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return hasher.digest("hex");
};

// Keys whose value is undefined are dropped rather than written as null, so an absent
// optional field and an explicitly undefined one hash the same.
// 值为 undefined 的键被丢弃而不是写成 null，缺省的可选字段与显式 undefined 的字段哈希相同。
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
