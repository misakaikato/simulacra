// Hooks shared by the pages: useLoad (a promise as {data, error, loading, reload} with
// stale-result protection), useInterval for polling and useDarkTheme following
// prefers-color-scheme.
// 页面共用的 hook：useLoad（把 promise 变成 {data, error, loading, reload}，带过期结果保护）、
// 轮询用的 useInterval，以及跟随 prefers-color-scheme 的 useDarkTheme。

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./format";

export interface Loadable<T> {
	readonly data: T | undefined;
	readonly error: string | undefined;
	readonly loading: boolean;
	readonly reload: () => void;
}

interface LoadState<T> {
	readonly data: T | undefined;
	readonly error: string | undefined;
	readonly loading: boolean;
}

// `live` stops a slow earlier request from overwriting a newer one; on reload and on error the
// previous data stays, so a polling page never flashes empty.
// `live` 防止较慢的旧请求覆盖新请求；重载与出错时保留先前的数据，轮询页面不会闪成空白。
export const useLoad = <T>(load: () => Promise<T>, deps: readonly unknown[]): Loadable<T> => {
	const [state, setState] = useState<LoadState<T>>({
		data: undefined,
		error: undefined,
		loading: true,
	});
	const [nonce, setNonce] = useState(0);
	const reload = useCallback(() => setNonce((n) => n + 1), []);
	useEffect(() => {
		let live = true;
		setState((s) => ({ ...s, loading: true }));
		load().then(
			(data) => {
				if (live) setState({ data, error: undefined, loading: false });
			},
			(e: unknown) => {
				if (live) setState((s) => ({ ...s, error: errorMessage(e), loading: false }));
			},
		);
		return () => {
			live = false;
		};
	}, [...deps, nonce]);
	return { ...state, reload };
};

// ms === null disables the timer; the callback ref keeps one interval alive across renders.
// ms === null 关闭定时器；回调 ref 让同一个 interval 跨渲染存活。
export const useInterval = (fn: () => void, ms: number | null): void => {
	const ref = useRef(fn);
	useEffect(() => {
		ref.current = fn;
	});
	useEffect(() => {
		if (ms === null) return undefined;
		const id = setInterval(() => ref.current(), ms);
		return () => clearInterval(id);
	}, [ms]);
};

const darkQuery = (): MediaQueryList => window.matchMedia("(prefers-color-scheme: dark)");

export const useDarkTheme = (): boolean => {
	const [dark, setDark] = useState(() => darkQuery().matches);
	useEffect(() => {
		const mq = darkQuery();
		const onChange = (): void => setDark(mq.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	return dark;
};
