// Canvas helpers shared by the network and metric charts: DPR-aware sizing, reading CSS custom
// properties for theme colours, hex colour mixing for the value ramp and a ResizeObserver hook.
// 网络图与指标图共用的 canvas 辅助：按 DPR 设尺寸、读取 CSS 自定义属性取主题色、
// 用于数值色阶的十六进制混色，以及 ResizeObserver hook。

import { useEffect, useRef, type RefObject } from "react";

export interface CanvasSize {
	readonly width: number;
	readonly height: number;
	readonly dpr: number;
}

// The backing store is CSS size times devicePixelRatio; assigning width or height resets the
// context, so they are assigned only when the size actually changed.
// 后备位图是 CSS 尺寸乘 devicePixelRatio；给 width 或 height 赋值会重置上下文，
// 因此只在尺寸真的变了时才赋值。
export const sizeCanvas = (canvas: HTMLCanvasElement): CanvasSize => {
	const rect = canvas.getBoundingClientRect();
	const dpr = window.devicePixelRatio || 1;
	const width = Math.max(1, Math.round(rect.width));
	const height = Math.max(1, Math.round(rect.height));
	if (canvas.width !== width * dpr) canvas.width = width * dpr;
	if (canvas.height !== height * dpr) canvas.height = height * dpr;
	return { width, height, dpr };
};

export const cssVar = (el: Element, name: string): string =>
	getComputedStyle(el).getPropertyValue(name).trim();

const expandHex = (hex: string): string =>
	hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;

const channel = (hex: string, i: number): number => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);

export const mixHex = (a: string, b: string, t: number): string => {
	const ha = expandHex(a);
	const hb = expandHex(b);
	const mix = (i: number): number =>
		Math.round(channel(ha, i) + (channel(hb, i) - channel(ha, i)) * t);
	return `rgb(${mix(0)} ${mix(1)} ${mix(2)})`;
};

// The callback lives in a ref so the observer is created once per element yet always calls the
// latest closure.
// 回调放在 ref 里，观察者每个元素只创建一次，却总能调到最新的闭包。
export const useResize = (ref: RefObject<HTMLElement | null>, onResize: () => void): void => {
	const callback = useRef(onResize);
	useEffect(() => {
		callback.current = onResize;
	});
	useEffect(() => {
		const el = ref.current;
		if (!el) return undefined;
		const observer = new ResizeObserver(() => callback.current());
		observer.observe(el);
		return () => observer.disconnect();
	}, [ref]);
};
