// Centre pane of the run page: a hand-written force-directed layout of the agent graph on a
// canvas with pan, zoom and node picking. Graphs above MAX_NODES are sampled by degree,
// repulsion uses a uniform grid so one step is near linear, and nodes are coloured by a numeric
// column (persona.stance by default) on a low-to-accent ramp.
// 运行页中栏：agent 图在 canvas 上的自写力导向布局，支持平移、缩放与点选节点。
// 超过 MAX_NODES 的图按度数采样，斥力用均匀网格使单步接近线性，节点按数值列
//（默认 persona.stance）从低色到强调色着色。

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { EntityId, Scalar } from "../../../src/core/types";
import type { AgentRow, GraphEdge } from "../api";
import { cssVar, mixHex, sizeCanvas, useResize } from "../canvas";
import { num } from "../format";
import { useDarkTheme } from "../hooks";
import { Empty } from "./Primitives";

export const MAX_NODES = 5000;
const DEFAULT_COLUMN = "persona.stance";

// Layout constants: a spring on each link towards LINK_LENGTH, grid-cell repulsion, a weak pull
// to the centre, velocity damping and an alpha that decays until ALPHA_MIN stops the loop.
// 布局常量：每条边向 LINK_LENGTH 收的弹簧、网格斥力、微弱的向心拉力、速度阻尼，
// 以及衰减到 ALPHA_MIN 即停止循环的 alpha。
const TAU = Math.PI * 2;
const CELL = 60;
const LINK_LENGTH = 30;
const LINK_STRENGTH = 0.06;
const REPULSION = 250;
const CENTER = 0.004;
const DAMPING = 0.55;
const DECAY = 0.985;
const ALPHA_MIN = 0.003;
const PICK_RADIUS = 10;

interface SimNode {
	readonly id: EntityId;
	readonly columns: Readonly<Record<string, Scalar>>;
	x: number;
	y: number;
	vx: number;
	vy: number;
	color: string;
}

interface SimLink {
	readonly a: SimNode;
	readonly b: SimNode;
}

interface Sim {
	readonly nodes: readonly SimNode[];
	readonly links: readonly SimLink[];
	readonly byId: ReadonlyMap<EntityId, SimNode>;
	alpha: number;
}

interface View {
	readonly k: number;
	readonly tx: number;
	readonly ty: number;
}

interface Drag {
	readonly sx: number;
	readonly sy: number;
	readonly tx: number;
	readonly ty: number;
	moved: boolean;
}

interface Range {
	readonly min: number;
	readonly max: number;
}

interface Sampled {
	readonly nodes: readonly AgentRow[];
	readonly edges: readonly GraphEdge[];
	readonly total: number;
}

interface Props {
	readonly agents: readonly AgentRow[];
	readonly edges: readonly GraphEdge[];
	readonly selected: EntityId | undefined;
	readonly onSelect: (id: EntityId | undefined) => void;
}

// FNV-1a on the id gives every node a stable initial position, so the same run lays out the
// same way on every load.
// 对 id 做 FNV-1a，每个节点的初始位置稳定，同一运行每次加载布局都一样。
const hash32 = (text: string): number => {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
};

// Above MAX_NODES the highest-degree nodes are kept (ties by id) and edges are restricted to
// the kept set; the toolbar reports the sampling so nobody mistakes the sample for the graph.
// 超过 MAX_NODES 时保留度数最高的节点（同度按 id），边只保留两端都在集合内的；
// 工具栏标明采样，免得把样本当成整张图。
const sampleGraph = (agents: readonly AgentRow[], edges: readonly GraphEdge[]): Sampled => {
	if (agents.length <= MAX_NODES) return { nodes: agents, edges, total: agents.length };
	const degree = new Map<EntityId, number>();
	for (const e of edges) {
		degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
		degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
	}
	const nodes = [...agents]
		.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1))
		.slice(0, MAX_NODES);
	const keep = new Set(nodes.map((n) => n.id));
	return {
		nodes,
		edges: edges.filter((e) => keep.has(e.src) && keep.has(e.dst)),
		total: agents.length,
	};
};

const numericColumns = (agents: readonly AgentRow[]): readonly string[] => {
	const names = new Set<string>();
	for (const a of agents)
		for (const [name, value] of Object.entries(a.columns))
			if (typeof value === "number") names.add(name);
	return [...names].sort();
};

// Nodes already present in the previous simulation keep their positions, so an SSE refresh
// nudges the layout instead of restarting it.
// 上一轮模拟里已有的节点保留位置，SSE 刷新只微调布局而不是从头再来。
const buildSim = (sampled: Sampled, previous: Sim | undefined): Sim => {
	const spread = 12 * Math.sqrt(sampled.nodes.length);
	const nodes = sampled.nodes.map((a): SimNode => {
		const prev = previous?.byId.get(a.id);
		const h = hash32(a.id);
		const angle = ((h % 3600) / 3600) * TAU;
		const radius = spread * Math.sqrt(((h >>> 12) % 1000) / 1000);
		return {
			id: a.id,
			columns: a.columns,
			x: prev?.x ?? Math.cos(angle) * radius,
			y: prev?.y ?? Math.sin(angle) * radius,
			vx: 0,
			vy: 0,
			color: "",
		};
	});
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const links: SimLink[] = [];
	for (const e of sampled.edges) {
		const a = byId.get(e.src);
		const b = byId.get(e.dst);
		if (a !== undefined && b !== undefined && a !== b) links.push({ a, b });
	}
	return { nodes, links, byId, alpha: 1 };
};

const cellKey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

// One layout iteration. Repulsion acts only between nodes in the same or adjacent grid cells,
// an O(n) approximation of n-body that is enough for a readable picture; distances are floored
// so coincident nodes cannot produce infinite forces.
// 一次布局迭代。斥力只在同一或相邻网格单元的节点之间起作用，是 n 体的 O(n) 近似，
// 足够画出可读的图；距离设了下限，重合的节点不会产生无穷大的力。
const step = (sim: Sim): void => {
	const alpha = sim.alpha;
	for (const { a, b } of sim.links) {
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const d = Math.sqrt(dx * dx + dy * dy) || 1e-3;
		const f = ((d - LINK_LENGTH) / d) * LINK_STRENGTH * alpha;
		a.vx += dx * f;
		a.vy += dy * f;
		b.vx -= dx * f;
		b.vy -= dy * f;
	}
	const grid = new Map<number, SimNode[]>();
	for (const n of sim.nodes) {
		const key = cellKey(Math.floor(n.x / CELL), Math.floor(n.y / CELL));
		const cell = grid.get(key);
		if (cell) cell.push(n);
		else grid.set(key, [n]);
	}
	for (const n of sim.nodes) {
		const cx = Math.floor(n.x / CELL);
		const cy = Math.floor(n.y / CELL);
		for (let ox = -1; ox <= 1; ox++)
			for (let oy = -1; oy <= 1; oy++) {
				const cell = grid.get(cellKey(cx + ox, cy + oy));
				if (!cell) continue;
				for (const m of cell) {
					if (m === n) continue;
					const dx = n.x - m.x;
					const dy = n.y - m.y;
					const d2 = Math.max(dx * dx + dy * dy, 4);
					const d = Math.sqrt(d2);
					const f = (REPULSION * alpha) / d2;
					n.vx += (dx / d) * f;
					n.vy += (dy / d) * f;
				}
			}
		n.vx -= n.x * CENTER * alpha;
		n.vy -= n.y * CENTER * alpha;
	}
	for (const n of sim.nodes) {
		n.x += n.vx;
		n.y += n.vy;
		n.vx *= DAMPING;
		n.vy *= DAMPING;
	}
	const next = alpha * DECAY;
	sim.alpha = next < ALPHA_MIN ? 0 : next;
};

// Nodes without the column get the low colour; a span of zero maps every value to the high
// colour. Returns the range for the legend, or undefined when no node had the column.
// 没有该列的节点取低色；跨度为零时所有值映射到高色。返回图例用的范围，无节点有该列时返回 undefined。
const colorize = (
	sim: Sim,
	column: string | undefined,
	low: string,
	high: string,
): Range | undefined => {
	let min = Infinity;
	let max = -Infinity;
	const values = sim.nodes.map((n) => {
		const raw = column === undefined ? undefined : n.columns[column];
		if (typeof raw !== "number") return undefined;
		min = Math.min(min, raw);
		max = Math.max(max, raw);
		return raw;
	});
	const span = max - min;
	sim.nodes.forEach((n, i) => {
		const v = values[i];
		n.color = v === undefined ? low : mixHex(low, high, span === 0 ? 1 : (v - min) / span);
	});
	return min <= max ? { min, max } : undefined;
};

const nodeRadius = (count: number): number => (count > 2000 ? 2 : count > 500 ? 3 : 4.5);

export const NetworkCanvas = ({ agents, edges, selected, onSelect }: Props) => {
	const dark = useDarkTheme();
	const sampled = useMemo(() => sampleGraph(agents, edges), [agents, edges]);
	const columns = useMemo(() => numericColumns(sampled.nodes), [sampled]);
	const [chosen, setChosen] = useState<string | undefined>(undefined);
	const column =
		chosen !== undefined && columns.includes(chosen)
			? chosen
			: columns.includes(DEFAULT_COLUMN)
				? DEFAULT_COLUMN
				: columns[0];
	const [range, setRange] = useState<Range | undefined>(undefined);
	const containerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const simRef = useRef<Sim | undefined>(undefined);
	const viewRef = useRef<View>({ k: 1, tx: 0, ty: 0 });
	const frameRef = useRef(0);
	const userMovedRef = useRef(false);
	const selectedRef = useRef(selected);
	const dragRef = useRef<Drag | undefined>(undefined);
	const hasCanvas = sampled.nodes.length > 0;

	// The transform maps layout space to CSS pixels through the view, then to device pixels
	// through dpr; edge alpha drops on dense graphs so nodes stay visible. Line widths are divided
	// by the zoom so they stay constant in CSS pixels.
	// 变换先经 view 把布局空间映射到 CSS 像素，再经 dpr 映射到设备像素；稠密图降低边的透明度，
	// 节点才不被淹没。线宽除以缩放比，在 CSS 像素下保持不变。
	const draw = useCallback(() => {
		const canvas = canvasRef.current;
		const sim = simRef.current;
		if (!canvas || !sim) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const { width, height, dpr } = sizeCanvas(canvas);
		const view = viewRef.current;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.setTransform(
			dpr * view.k,
			0,
			0,
			dpr * view.k,
			dpr * (width / 2 + view.tx),
			dpr * (height / 2 + view.ty),
		);
		ctx.strokeStyle = cssVar(canvas, "--edge");
		ctx.lineWidth = 1 / view.k;
		ctx.globalAlpha = sim.links.length > 5000 ? 0.15 : 0.4;
		ctx.beginPath();
		for (const { a, b } of sim.links) {
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(b.x, b.y);
		}
		ctx.stroke();
		ctx.globalAlpha = 1;
		const r = nodeRadius(sim.nodes.length);
		for (const n of sim.nodes) {
			ctx.fillStyle = n.color;
			ctx.beginPath();
			ctx.arc(n.x, n.y, r, 0, TAU);
			ctx.fill();
		}
		const current = selectedRef.current;
		const focus = current === undefined ? undefined : sim.byId.get(current);
		if (focus) {
			ctx.strokeStyle = cssVar(canvas, "--accent");
			ctx.lineWidth = 2 / view.k;
			ctx.beginPath();
			ctx.arc(focus.x, focus.y, r + 3 / view.k, 0, TAU);
			ctx.stroke();
		}
	}, []);

	const fit = useCallback(() => {
		const canvas = canvasRef.current;
		const sim = simRef.current;
		if (!canvas || !sim || sim.nodes.length === 0) return;
		const { width, height } = sizeCanvas(canvas);
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of sim.nodes) {
			minX = Math.min(minX, n.x);
			maxX = Math.max(maxX, n.x);
			minY = Math.min(minY, n.y);
			maxY = Math.max(maxY, n.y);
		}
		const k = Math.min(
			4,
			Math.max(0.02, Math.min(width / (maxX - minX + 60), height / (maxY - minY + 60))),
		);
		viewRef.current = { k, tx: (-(minX + maxX) / 2) * k, ty: (-(minY + maxY) / 2) * k };
		userMovedRef.current = false;
		draw();
	}, [draw]);

	// Two steps per frame while alpha > 0. The view auto-fits each frame until the user pans or
	// zooms; after that only draw() runs so the layout never moves under the pointer.
	// alpha > 0 时每帧两步。用户平移或缩放之前每帧自动适配视图；之后只跑 draw()，
	// 布局不会在指针下面移动。
	const loop = useCallback(() => {
		frameRef.current = 0;
		const sim = simRef.current;
		if (!sim) return;
		if (sim.alpha > 0) {
			step(sim);
			step(sim);
			if (userMovedRef.current) draw();
			else fit();
			if (sim.alpha > 0) frameRef.current = requestAnimationFrame(loop);
		} else draw();
	}, [draw, fit]);

	const kick = useCallback(() => {
		if (frameRef.current === 0) frameRef.current = requestAnimationFrame(loop);
	}, [loop]);

	useEffect(() => {
		simRef.current = buildSim(sampled, simRef.current);
		kick();
	}, [sampled, kick]);

	useEffect(
		() => () => {
			if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
		},
		[],
	);

	useEffect(() => {
		const sim = simRef.current;
		const canvas = canvasRef.current;
		if (!sim || !canvas) return;
		setRange(colorize(sim, column, cssVar(canvas, "--node-low"), cssVar(canvas, "--accent")));
		draw();
	}, [sampled, column, dark, draw]);

	useEffect(() => {
		selectedRef.current = selected;
		draw();
	}, [selected, draw]);

	useResize(containerRef, () => {
		if (userMovedRef.current) draw();
		else fit();
	});

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return undefined;
		// Zoom about the pointer: the layout point under the cursor stays fixed. Registered
		// natively with passive: false because React's onWheel cannot preventDefault scrolling.
		// 围绕指针缩放：光标下的布局点保持不动。以 passive: false 原生注册，
		// 因为 React 的 onWheel 无法 preventDefault 阻止页面滚动。
		const onWheel = (e: WheelEvent): void => {
			e.preventDefault();
			const { width, height } = sizeCanvas(canvas);
			const rect = canvas.getBoundingClientRect();
			const px = e.clientX - rect.left - width / 2;
			const py = e.clientY - rect.top - height / 2;
			const view = viewRef.current;
			const k = Math.min(8, Math.max(0.02, view.k * Math.exp(-e.deltaY * 0.0015)));
			const lx = (px - view.tx) / view.k;
			const ly = (py - view.ty) / view.k;
			viewRef.current = { k, tx: px - lx * k, ty: py - ly * k };
			userMovedRef.current = true;
			draw();
		};
		canvas.addEventListener("wheel", onWheel, { passive: false });
		return () => canvas.removeEventListener("wheel", onWheel);
	}, [draw, hasCanvas]);

	// Picking works in layout space with a radius scaled by the zoom, so a node is as easy to hit
	// zoomed out as zoomed in; the nearest node within the radius wins.
	// 拾取在布局空间进行，半径随缩放比换算，缩小与放大时节点一样好点中；半径内最近的节点胜出。
	const pick = (clientX: number, clientY: number): EntityId | undefined => {
		const canvas = canvasRef.current;
		const sim = simRef.current;
		if (!canvas || !sim) return undefined;
		const { width, height } = sizeCanvas(canvas);
		const rect = canvas.getBoundingClientRect();
		const view = viewRef.current;
		const lx = (clientX - rect.left - width / 2 - view.tx) / view.k;
		const ly = (clientY - rect.top - height / 2 - view.ty) / view.k;
		const radius = PICK_RADIUS / view.k;
		let best: SimNode | undefined;
		let bestD = radius * radius;
		for (const n of sim.nodes) {
			const d = (n.x - lx) ** 2 + (n.y - ly) ** 2;
			if (d < bestD) {
				bestD = d;
				best = n;
			}
		}
		return best?.id;
	};

	// Pointer capture keeps a drag alive outside the canvas; a move under 3 px still counts as a
	// click, so a slightly shaky click selects instead of panning.
	// 指针捕获让拖拽越出画布也不中断；移动不足 3 像素仍算点击，手抖的点击是选择而不是平移。
	const onPointerDown = (e: PointerEvent<HTMLCanvasElement>): void => {
		const view = viewRef.current;
		dragRef.current = { sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty, moved: false };
		e.currentTarget.setPointerCapture(e.pointerId);
	};

	const onPointerMove = (e: PointerEvent<HTMLCanvasElement>): void => {
		const drag = dragRef.current;
		if (!drag) return;
		const dx = e.clientX - drag.sx;
		const dy = e.clientY - drag.sy;
		if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
		drag.moved = true;
		userMovedRef.current = true;
		viewRef.current = { ...viewRef.current, tx: drag.tx + dx, ty: drag.ty + dy };
		draw();
	};

	const onPointerUp = (e: PointerEvent<HTMLCanvasElement>): void => {
		const drag = dragRef.current;
		dragRef.current = undefined;
		if (drag && !drag.moved) onSelect(pick(e.clientX, e.clientY));
	};

	return (
		<div className="canvas-pane">
			<div className="canvas-toolbar">
				<label>
					Color by
					<select
						value={column ?? ""}
						onChange={(e) =>
							setChosen(e.target.value === "" ? undefined : e.target.value)
						}
						disabled={columns.length === 0}
					>
						{columns.length === 0 ? (
							<option value="">no numeric columns</option>
						) : (
							columns.map((c) => (
								<option key={c} value={c}>
									{c}
								</option>
							))
						)}
					</select>
				</label>
				<span className="mono muted">
					{sampled.nodes.length} nodes, {sampled.edges.length} edges
				</span>
				{sampled.total > sampled.nodes.length && (
					<span className="notice">
						Showing {sampled.nodes.length} of {sampled.total} nodes, sampled by degree
					</span>
				)}
				<button type="button" onClick={fit}>
					Fit
				</button>
			</div>
			<div className="canvas-body" ref={containerRef}>
				{hasCanvas ? (
					<canvas
						ref={canvasRef}
						onPointerDown={onPointerDown}
						onPointerMove={onPointerMove}
						onPointerUp={onPointerUp}
						onPointerCancel={() => {
							dragRef.current = undefined;
						}}
					/>
				) : (
					<Empty label="No agents" />
				)}
				{range !== undefined && column !== undefined && (
					<div className="legend">
						<span className="mono">{num(range.min)}</span>
						<span className="legend-ramp" />
						<span className="mono">{num(range.max)}</span>
						<span className="muted">{column}</span>
					</div>
				)}
			</div>
		</div>
	);
};
