// VitePress configuration of the static site: locales (English root, Chinese under /zh/), nav
// and sidebar per locale, the GitHub Pages base path (SITE_BASE overrides it, "/" for a custom
// domain) and the Open Graph tags. The description comes from package.json so the site never
// carries a second copy of it.
// 静态站的 VitePress 配置：语言（根为英文，/zh/ 为中文）、按语言的导航与侧栏、GitHub Pages 的 base
// 路径（SITE_BASE 可覆盖，自定义域名时设为 "/"）以及 Open Graph 标签。描述取自 package.json，
// 站点不保留第二份。

import { readFileSync } from "node:fs";
import { defineConfig, type DefaultTheme } from "vitepress";

const GITHUB_URL = "https://github.com/misakaikato/simulacra";
const NPM_URL = "https://www.npmjs.com/package/@misakaikato/simulacra";
const CONTACT = "misakaikato@outlook.com";
const DEFAULT_BASE = "/simulacra/";
const DEFAULT_ORIGIN = "https://misakaikato.github.io";
const ZH_DESCRIPTION =
	"面向 LLM 驱动社会模拟的类型化事件溯源内核，内置稳健性审计。CLI、HTTP API、MCP 服务与 GUI 共用一套公共 API。";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
	readonly description: string;
};

// A base must start and end with a slash; "" and "/" both mean the site root.
// base 必须以斜杠开头和结尾；"" 与 "/" 都表示站点根。
const normalizeBase = (value: string): string => {
	const trimmed = value.replace(/^\/+|\/+$/g, "");
	return trimmed.length === 0 ? "/" : `/${trimmed}/`;
};

// An unset or empty variable (a CI variable that was never defined) means the default.
// 未设置或为空的变量（CI 里从未定义的变量）表示默认值。
const envOr = (name: string, fallback: string): string => {
	const value = process.env[name];
	return value === undefined || value.length === 0 ? fallback : value;
};

const base = normalizeBase(envOr("SITE_BASE", DEFAULT_BASE));
const origin = envOr("SITE_ORIGIN", DEFAULT_ORIGIN).replace(/\/+$/, "");

const guideItems: DefaultTheme.SidebarItem[] = [
	{ text: "Scenarios", link: "/guide/scenarios" },
	{ text: "Audits", link: "/guide/audits" },
	{ text: "Plugins", link: "/guide/plugins" },
];

const entryItems: DefaultTheme.SidebarItem[] = [
	{ text: "CLI", link: "/guide/cli" },
	{ text: "HTTP API", link: "/guide/api" },
	{ text: "MCP", link: "/guide/mcp" },
	{ text: "GUI", link: "/guide/gui" },
];

const zhGuideItems: DefaultTheme.SidebarItem[] = [
	{ text: "场景", link: "/zh/guide/scenarios" },
	{ text: "审计", link: "/zh/guide/audits" },
	{ text: "插件", link: "/zh/guide/plugins" },
];

const zhEntryItems: DefaultTheme.SidebarItem[] = [
	{ text: "CLI", link: "/zh/guide/cli" },
	{ text: "HTTP API", link: "/zh/guide/api" },
	{ text: "MCP", link: "/zh/guide/mcp" },
	{ text: "GUI", link: "/zh/guide/gui" },
];

const nav: DefaultTheme.NavItem[] = [
	{ text: "Guide", link: "/guide/getting-started", activeMatch: "^/guide/" },
	{ text: "Examples", link: "/examples" },
	{ text: "Benchmarks", link: "/benchmarks" },
	{ text: "Report", link: "/report" },
	{ text: "Services", link: "/services" },
];

const sidebar: DefaultTheme.Sidebar = {
	"/guide/": [
		{ text: "Start", items: [{ text: "Getting started", link: "/guide/getting-started" }] },
		{ text: "Reference", items: guideItems },
		{ text: "Entry points", items: entryItems },
	],
};

// Every English page has a Chinese counterpart under /zh/, so the Chinese nav and sidebar stay
// inside the Chinese locale.
// 每个英文页在 /zh/ 下都有对应的中文页，所以中文导航与侧栏只指向中文页。

const zhNav: DefaultTheme.NavItem[] = [
	{ text: "指南", link: "/zh/guide/getting-started", activeMatch: "^/zh/guide/" },
	{ text: "示例", link: "/zh/examples" },
	{ text: "基准", link: "/zh/benchmarks" },
	{ text: "报告", link: "/zh/report" },
	{ text: "咨询与定制", link: "/zh/services" },
];

const zhSidebar: DefaultTheme.Sidebar = {
	"/zh/guide/": [
		{ text: "开始", items: [{ text: "快速开始", link: "/zh/guide/getting-started" }] },
		{ text: "参考", items: zhGuideItems },
		{ text: "入口", items: zhEntryItems },
	],
};

const footer: DefaultTheme.Footer = {
	message: `Apache-2.0 · <a href="mailto:${CONTACT}">${CONTACT}</a>`,
	copyright: "Copyright 2026 misakaikato",
};

export default defineConfig({
	title: "simulacra",
	description: pkg.description,
	base,
	head: [
		["meta", { property: "og:type", content: "website" }],
		["meta", { property: "og:title", content: "simulacra" }],
		["meta", { property: "og:description", content: pkg.description }],
		["meta", { property: "og:image", content: `${origin}${base}banner.jpg` }],
	],
	locales: {
		root: {
			label: "English",
			lang: "en-US",
			themeConfig: { nav, sidebar },
		},
		zh: {
			label: "中文",
			lang: "zh-CN",
			link: "/zh/",
			description: ZH_DESCRIPTION,
			themeConfig: {
				nav: zhNav,
				sidebar: zhSidebar,
				outline: { label: "本页目录" },
				docFooter: { prev: "上一页", next: "下一页" },
				darkModeSwitchLabel: "外观",
				sidebarMenuLabel: "菜单",
				returnToTopLabel: "回到顶部",
				langMenuLabel: "语言",
			},
		},
	},
	themeConfig: {
		outline: { level: [2, 3] },
		socialLinks: [
			{ icon: "github", link: GITHUB_URL },
			{ icon: "npm", link: NPM_URL },
		],
		footer,
	},
});
