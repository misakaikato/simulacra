// Build-time inputs of the site, run by `bun run build:site` before `vitepress build`: verifies
// the include anchors, copies the banner and screenshots into site/public, and runs the
// prisoner's dilemma audit with the mock provider over five replications to produce the live
// report at site/public/demo/report.html. No key and no network are ever needed.
// 站点的构建期输入，由 `bun run build:site` 在 `vitepress build` 之前运行：校验包含锚点，把横幅与
// 截图复制到 site/public，并用 mock provider 跑五次复制的囚徒困境审计，产出活报告
// site/public/demo/report.html。永远不需要密钥与网络。

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	REPORT_FILE,
	audit,
	kernelRunFn,
	loadAuditPlan,
	renderReportHtml,
	silentLogger,
} from "../../src/index";
import { verifyIncludes } from "./includes";

const ROOT = resolve(import.meta.dir, "../..");
const SITE_DIR = join(ROOT, "site");
const PUBLIC_DIR = join(SITE_DIR, "public");
const DEMO_DIR = join(PUBLIC_DIR, "demo");
const BANNER = "banner.jpg";
const SCREENSHOTS_DIR = "screenshots";
const DEMO_PLAN = join(ROOT, "examples/prisoners_dilemma/audit.yaml");
const DEMO_REPLICATIONS = 5;
const PROVIDER = "mock";

// A function declaration, so TypeScript narrows after each `if (!x.ok) fail(...)`.
// 用函数声明，TypeScript 才会在每个 `if (!x.ok) fail(...)` 之后收窄类型。
function fail(message: string): never {
	console.error(`demo-report: ${message}`);
	process.exit(1);
}

const issues = verifyIncludes(SITE_DIR);
if (issues.length > 0)
	fail(
		[
			"include check failed",
			...issues.map((i) => `  ${i.file}: ${i.directive}: ${i.message}`),
		].join("\n"),
	);

// Binary assets are copied at build time so they are committed once, under docs/.
// 二进制资产在构建时复制，仓库里只在 docs/ 下提交一次。
mkdirSync(join(PUBLIC_DIR, SCREENSHOTS_DIR), { recursive: true });
copyFileSync(join(ROOT, "docs", BANNER), join(PUBLIC_DIR, BANNER));
const screenshots = readdirSync(join(ROOT, "docs", SCREENSHOTS_DIR)).filter((f) =>
	f.endsWith(".jpg"),
);
for (const name of screenshots)
	copyFileSync(
		join(ROOT, "docs", SCREENSHOTS_DIR, name),
		join(PUBLIC_DIR, SCREENSHOTS_DIR, name),
	);

const plan = loadAuditPlan(DEMO_PLAN);
if (!plan.ok) fail(`${DEMO_PLAN}: ${plan.error.map((i) => i.message).join("; ")}`);

// The audit runs in a temporary directory; only the rendered report enters site/public. Same
// plan, same mock provider and same seeds give the same bytes on every build.
// 审计在临时目录里运行，只有渲染出的报告进入 site/public。同一计划、同一 mock provider 与同一
// 种子，每次构建产出相同的字节。
const outDir = mkdtempSync(join(tmpdir(), "simulacra-site-demo-"));
try {
	const report = await audit(plan.value, kernelRunFn({ providerOverride: PROVIDER }), outDir, {
		logger: silentLogger,
		replications: DEMO_REPLICATIONS,
		providerOverride: PROVIDER,
	});
	if (!report.ok) fail(`audit failed: ${JSON.stringify(report.error)}`);
	mkdirSync(DEMO_DIR, { recursive: true });
	writeFileSync(join(DEMO_DIR, REPORT_FILE), renderReportHtml(report.value));
	const r = report.value;
	console.log(
		`demo-report: ${r.evidenceGrade} evidence, ${r.conditions.length} conditions, ${r.runs.length} runs, ${r.pairwise.length} pairwise tests`,
	);
	console.log(
		`demo-report: ${screenshots.length + 1} images and ${REPORT_FILE} written under site/public`,
	);
} finally {
	rmSync(outDir, { recursive: true, force: true });
}
