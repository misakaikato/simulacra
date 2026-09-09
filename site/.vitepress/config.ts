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

const base = normalizeBase(process.env.SITE_BASE ?? DEFAULT_BASE);
const origin = (process.env.SITE_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/+$/, "");

const guideItems = (suffix = ""): DefaultTheme.SidebarItem[] => [
	{ text: `Scenarios${suffix}`, link: "/guide/scenarios" },
	{ text: `Audits${suffix}`, link: "/guide/audits" },
	{ text: `Plugins${suffix}`, link: "/guide/plugins" },
];

const entryItems = (suffix = ""): DefaultTheme.SidebarItem[] => [
	{ text: `CLI${suffix}`, link: "/guide/cli" },
	{ text: `HTTP API${suffix}`, link: "/guide/api" },
	{ text: `MCP${suffix}`, link: "/guide/mcp" },
	{ text: `GUI${suffix}`, link: "/guide/gui" },
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
		{ text: "Reference", items: guideItems() },
		{ text: "Entry points", items: entryItems() },
	],
};

// Chinese pages exist for the landing page, the quick start and the services page; every other
// entry links to the English page and says so.
// 中文页面只有首页、快速开始与咨询页；其余条目链接到英文页并注明。
const EN = " (English)";

const zhNav: DefaultTheme.NavItem[] = [
	{ text: "指南", link: "/zh/guide/getting-started", activeMatch: "^/zh/guide/" },
	{ text: `示例${EN}`, link: "/examples" },
	{ text: `基准${EN}`, link: "/benchmarks" },
	{ text: `报告${EN}`, link: "/report" },
	{ text: "咨询与定制", link: "/zh/services" },
];

const zhSidebar: DefaultTheme.Sidebar = {
	"/zh/guide/": [
		{ text: "开始", items: [{ text: "快速开始", link: "/zh/guide/getting-started" }] },
		{ text: "参考", items: guideItems(EN) },
		{ text: "入口", items: entryItems(EN) },
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
