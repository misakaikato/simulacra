import { describe, expect, test } from "bun:test";
import { canonicalJson, hashOf, sha256Hex } from "../../src/core/hash";

describe("canonicalJson", () => {
	test("sorts object keys recursively and keeps array order", () => {
		const a = canonicalJson({ b: [3, { z: 1, y: 2 }], a: "x" });
		const b = canonicalJson({ a: "x", b: [3, { y: 2, z: 1 }] });
		expect(a).toBe(b);
		expect(a).toBe('{"a":"x","b":[3,{"y":2,"z":1}]}');
	});

	test("drops undefined properties and encodes null", () => {
		expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
		expect(canonicalJson(undefined)).toBe("null");
	});

	test("rejects functions", () => {
		expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
	});
});

describe("sha256Hex", () => {
	test("matches the known digest of 'abc'", () => {
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	test("hashOf is key-order independent", () => {
		expect(hashOf({ x: 1, y: 2 })).toBe(hashOf({ y: 2, x: 1 }));
		expect(hashOf({ x: 1 })).not.toBe(hashOf({ x: 2 }));
	});
});
