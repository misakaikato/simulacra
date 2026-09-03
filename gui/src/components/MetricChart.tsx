// Line chart of the measurement series on a canvas: nice-step axes, one colour per series from
// the CSS palette, a dashed marker at the selected tick and a hover readout that snaps to the
// nearest measured tick. Redraws on data, theme and container size changes.
// canvas 上的测量序列折线图：取整刻度坐标轴、每条序列取 CSS 调色板一色、所选 tick 的虚线标记，
// 以及吸附到最近测量 tick 的悬停读数。数据、主题或容器尺寸变化时重绘。

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { MetricSeries } from "../api";
import { cssVar, sizeCanvas, useResize } from "../canvas";
import { num } from "../format";
import { useDarkTheme } from "../hooks";
import { Empty } from "./Primitives";

const PALETTE = ["--accent", "--series-2", "--series-3", "--series-4", "--series-5", "--series-6"];
const PAD = { left: 54, right: 14, top: 10, bottom: 22 };
const FONT = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

interface Props {
	readonly series: MetricSeries;
	readonly marker: number | undefined;
}

const paletteVar = (i: number): string => PALETTE[i % PALETTE.length] ?? "--accent";

// 1-2-5 step selection so grid labels are round numbers at any range.
// 1-2-5 步长选择，任何量程下网格标签都是整数。
const niceStep = (range: number, target: number): number => {
	if (range <= 0) return 1;
	const raw = range / target;
	const magnitude = 10 ** Math.floor(Math.log10(raw));
	const norm = raw / magnitude;
	return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * magnitude;
};

const nearest = (ticks: readonly number[], x: number): number | undefined => {
	let best: number | undefined;
	let bestD = Infinity;
	for (const t of ticks) {
		const d = Math.abs(t - x);
		if (d < bestD) {
			bestD = d;
			best = t;
		}
	}
	return best;
};

export const MetricChart = ({ series, marker }: Props) => {
	const dark = useDarkTheme();
	const names = useMemo(() => Object.keys(series).sort(), [series]);
	const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
	const [hover, setHover] = useState<number | undefined>(undefined);
	const containerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);

	const visible = useMemo(() => names.filter((n) => !hidden.has(n)), [names, hidden]);
	const ticks = useMemo(() => {
		const set = new Set<number>();
		for (const n of visible) for (const p of series[n] ?? []) set.add(p.tick);
		return [...set].sort((a, b) => a - b);
	}, [series, visible]);

	const draw = useCallback(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const { width, height, dpr } = sizeCanvas(canvas);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		if (ticks.length === 0) return;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const n of visible)
			for (const p of series[n] ?? []) {
				minY = Math.min(minY, p.value);
				maxY = Math.max(maxY, p.value);
			}
		// A flat series is padded by one unit on each side so it draws as a visible line, not on
		// the border.
		// 平直的序列上下各留一个单位，画成看得见的线而不是压在边框上。
		if (minY === maxY) {
			minY -= 1;
			maxY += 1;
		}
		const padY = (maxY - minY) * 0.05;
		minY -= padY;
		maxY += padY;
		const minX = ticks[0] ?? 0;
		const maxX = Math.max(ticks[ticks.length - 1] ?? 0, minX + 1);
		const plotW = width - PAD.left - PAD.right;
		const plotH = height - PAD.top - PAD.bottom;
		const sx = (t: number): number => PAD.left + ((t - minX) / (maxX - minX)) * plotW;
		const sy = (v: number): number => PAD.top + (1 - (v - minY) / (maxY - minY)) * plotH;
		const border = cssVar(canvas, "--border");
		const muted = cssVar(canvas, "--muted");
		const text = cssVar(canvas, "--text");
		const surface = cssVar(canvas, "--surface");
		ctx.font = FONT;
		ctx.lineWidth = 1;
		ctx.strokeStyle = border;
		ctx.fillStyle = muted;
		ctx.textAlign = "right";
		ctx.textBaseline = "middle";
		const stepY = niceStep(maxY - minY, 4);
		for (let v = Math.ceil(minY / stepY) * stepY; v <= maxY; v += stepY) {
			const y = sy(v);
			ctx.beginPath();
			ctx.moveTo(PAD.left, y);
			ctx.lineTo(width - PAD.right, y);
			ctx.stroke();
			ctx.fillText(num(v, 2), PAD.left - 6, y);
		}
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		const stepX = Math.max(1, niceStep(maxX - minX, Math.max(2, Math.floor(plotW / 60))));
		for (let t = Math.ceil(minX / stepX) * stepX; t <= maxX; t += stepX)
			ctx.fillText(String(t), sx(t), height - PAD.bottom + 6);
		ctx.strokeStyle = muted;
		ctx.beginPath();
		ctx.moveTo(PAD.left, PAD.top);
		ctx.lineTo(PAD.left, height - PAD.bottom);
		ctx.lineTo(width - PAD.right, height - PAD.bottom);
		ctx.stroke();
		for (const n of visible) {
			const points = series[n] ?? [];
			ctx.strokeStyle = cssVar(canvas, paletteVar(names.indexOf(n)));
			ctx.fillStyle = ctx.strokeStyle;
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			points.forEach((p, j) => {
				if (j === 0) ctx.moveTo(sx(p.tick), sy(p.value));
				else ctx.lineTo(sx(p.tick), sy(p.value));
			});
			ctx.stroke();
			// Dots mark individual measurements only while sparse; dense series stay a line.
			// 稀疏时用圆点标出每个测量；稠密的序列只画线。
			if (points.length < 60)
				for (const p of points) {
					ctx.beginPath();
					ctx.arc(sx(p.tick), sy(p.value), 2, 0, Math.PI * 2);
					ctx.fill();
				}
		}
		if (marker !== undefined && marker >= minX && marker <= maxX) {
			ctx.strokeStyle = cssVar(canvas, "--accent");
			ctx.setLineDash([4, 3]);
			ctx.beginPath();
			ctx.moveTo(sx(marker), PAD.top);
			ctx.lineTo(sx(marker), height - PAD.bottom);
			ctx.stroke();
			ctx.setLineDash([]);
		}
		// The readout lists the value of every visible series at the hovered tick; the box flips to
		// the left of the cursor near the right edge so it never leaves the canvas.
		// 读数列出悬停 tick 上每条可见序列的值；靠近右边缘时框翻到光标左侧，绝不跑出画布。
		if (hover !== undefined) {
			const x = sx(hover);
			ctx.strokeStyle = muted;
			ctx.beginPath();
			ctx.moveTo(x, PAD.top);
			ctx.lineTo(x, height - PAD.bottom);
			ctx.stroke();
			const lines = [`tick ${hover}`];
			for (const n of visible) {
				const p = (series[n] ?? []).find((q) => q.tick === hover);
				if (p) lines.push(`${n} ${num(p.value, 4)}`);
			}
			ctx.textAlign = "left";
			ctx.textBaseline = "top";
			const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
			const boxH = lines.length * 15 + 10;
			const bx = x + 10 + boxW > width ? x - 10 - boxW : x + 10;
			const by = PAD.top + 4;
			ctx.fillStyle = surface;
			ctx.strokeStyle = border;
			ctx.fillRect(bx, by, boxW, boxH);
			ctx.strokeRect(bx, by, boxW, boxH);
			lines.forEach((l, i) => {
				ctx.fillStyle = i === 0 ? muted : text;
				ctx.fillText(l, bx + 8, by + 5 + i * 15);
			});
		}
	}, [series, names, visible, ticks, marker, hover]);

	// `dark` is a dependency so a theme switch re-reads the CSS variables.
	// `dark` 列入依赖，切换主题会重新读取 CSS 变量。
	useEffect(() => {
		draw();
	}, [draw, dark]);
	useResize(containerRef, draw);

	// The pointer x is mapped back to tick space and snapped to the nearest tick that has a point,
	// so the readout always shows real values and never interpolates.
	// 指针 x 反算回 tick 空间并吸附到最近有数据点的 tick，读数永远是真实值，绝不插值。
	const onMouseMove = (e: MouseEvent<HTMLCanvasElement>): void => {
		const canvas = e.currentTarget;
		const rect = canvas.getBoundingClientRect();
		const minX = ticks[0] ?? 0;
		const maxX = Math.max(ticks[ticks.length - 1] ?? 0, minX + 1);
		const plotW = rect.width - PAD.left - PAD.right;
		const t = minX + ((e.clientX - rect.left - PAD.left) / plotW) * (maxX - minX);
		setHover(nearest(ticks, t));
	};

	const toggle = (name: string): void =>
		setHidden((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});

	return (
		<div className="chart">
			{names.length > 0 && (
				<div className="chart-legend">
					{names.map((n, i) => (
						<button
							type="button"
							key={n}
							className={`legend-item${hidden.has(n) ? " off" : ""}`}
							onClick={() => toggle(n)}
						>
							<span
								className="swatch"
								style={{ background: `var(${paletteVar(i)})` }}
							/>
							{n}
						</button>
					))}
				</div>
			)}
			<div className="chart-body" ref={containerRef}>
				{names.length === 0 ? (
					<Empty label="No measurements yet" />
				) : (
					<canvas
						ref={canvasRef}
						onMouseMove={onMouseMove}
						onMouseLeave={() => setHover(undefined)}
					/>
				)}
			</div>
		</div>
	);
};
