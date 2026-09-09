// Checks every `<!--@include: path#region-->` directive in the site's markdown before VitePress
// runs. VitePress itself leaves the directive in place when the file is missing and includes the
// whole file when the region is missing, both silently; a deleted README anchor must fail the
// build instead.
// 在 VitePress 运行前检查站点 markdown 里的每条 `<!--@include: path#region-->` 指令。VitePress
// 本身在文件缺失时原样保留指令、在区域缺失时包含整个文件，两者都不报错；README 锚点被删必须让
// 构建失败。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const INCLUDE = /<!--\s*@include:\s*(.*?)\s*-->/g;
const RANGE = /\{(\d*),(\d*)\}$/;
const REGION = /#([\w-]+)$/;
const MARKER = /^<!-- #?((?:end)?region) ([\w*-]+) -->$/;
const SKIPPED_DIRS = new Set(["node_modules", "public"]);

export interface IncludeIssue {
	readonly file: string;
	readonly directive: string;
	readonly message: string;
}

const markdownFiles = (dir: string): readonly string[] => {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...markdownFiles(path));
		else if (entry.name.endsWith(".md")) out.push(path);
	}
	return out;
};

// Both markers must be present under the given name, in this order.
// 两个标记都必须以该名字出现，且先开后闭。
const hasRegion = (text: string, name: string): boolean => {
	let open = false;
	for (const line of text.split(/\r?\n/)) {
		const m = MARKER.exec(line);
		if (m === null || m[2] !== name) continue;
		if (m[1] === "region") open = true;
		else if (open) return true;
	}
	return false;
};

export const verifyIncludes = (siteDir: string): readonly IncludeIssue[] => {
	const issues: IncludeIssue[] = [];
	for (const file of markdownFiles(siteDir)) {
		const text = readFileSync(file, "utf8");
		for (const match of text.matchAll(INCLUDE)) {
			const directive = match[0];
			const report = (message: string): void => {
				issues.push({ file: relative(siteDir, file), directive, message });
			};
			let spec = (match[1] ?? "").replace(RANGE, "");
			const region = REGION.exec(spec)?.[1];
			if (region !== undefined) spec = spec.replace(REGION, "");
			if (spec.length === 0) {
				report("empty include path");
				continue;
			}
			// `@/` is the site root, anything else is relative to the markdown file (VitePress rule)
			// `@/` 表示站点根目录，其余相对于该 markdown 文件（VitePress 的规则）
			const target = spec.startsWith("@")
				? resolve(siteDir, spec.slice(spec.startsWith("@/") ? 2 : 1))
				: resolve(dirname(file), spec);
			if (!existsSync(target)) {
				report(`included file not found: ${target}`);
				continue;
			}
			if (region !== undefined && !hasRegion(readFileSync(target, "utf8"), region))
				report(`region '${region}' not found in ${target}`);
		}
	}
	return issues;
};
