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
