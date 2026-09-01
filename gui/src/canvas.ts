import { useEffect, useRef, type RefObject } from "react";

export interface CanvasSize {
	readonly width: number;
	readonly height: number;
	readonly dpr: number;
}

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
