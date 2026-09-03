// Root component with the hash router: #/runs, #/runs/<id> and #/audits/<id> map to the three
// pages; ids are URL-decoded because runIds contain a colon. Hash routing needs no server-side
// route configuration, so `simulacra serve` can hand out gui/dist as plain static files.
// 根组件与 hash 路由：#/runs、#/runs/<id>、#/audits/<id> 对应三个页面；id 经 URL 解码，
// 因为 runId 含冒号。hash 路由不需要服务端路由配置，`simulacra serve` 把 gui/dist 当普通静态文件
// 发出即可。

import { useEffect, useState } from "react";
import { Audit } from "./pages/Audit";
import { Run } from "./pages/Run";
import { Runs } from "./pages/Runs";

type Route =
	| { readonly page: "runs" }
	| { readonly page: "run"; readonly id: string }
	| { readonly page: "audit"; readonly id: string }
	| { readonly page: "missing"; readonly hash: string };

// Anything that does not match exactly falls to the missing page rather than the runs list, so
// a typo in a link stays visible.
// 不能精确匹配的一律落到 missing 页而不是运行列表，链接里的笔误才看得见。
const parseRoute = (hash: string): Route => {
	const parts = hash
		.replace(/^#\/?/, "")
		.split("/")
		.filter((p) => p !== "")
		.map(decodeURIComponent);
	const [head, id] = parts;
	if (head === undefined || (head === "runs" && parts.length === 1)) return { page: "runs" };
	if (head === "runs" && id !== undefined && parts.length === 2) return { page: "run", id };
	if (head === "audits" && id !== undefined && parts.length === 2) return { page: "audit", id };
	return { page: "missing", hash };
};

const useHashRoute = (): Route => {
	const [route, setRoute] = useState(() => parseRoute(location.hash));
	useEffect(() => {
		const onChange = (): void => setRoute(parseRoute(location.hash));
		window.addEventListener("hashchange", onChange);
		return () => window.removeEventListener("hashchange", onChange);
	}, []);
	return route;
};

const Page = ({ route }: { readonly route: Route }) => {
	switch (route.page) {
		case "runs":
			return <Runs />;
		case "run":
			return <Run id={route.id} />;
		case "audit":
			return <Audit id={route.id} />;
		case "missing":
			return (
				<div className="page">
					<div className="error-bar">
						No page at <span className="mono">{route.hash}</span>
					</div>
				</div>
			);
	}
};

export const App = () => {
	const route = useHashRoute();
	return (
		<div className="app">
			<nav className="topbar">
				<a href="#/runs" className="brand">
					simulacra
				</a>
				<a href="#/runs" className={route.page === "runs" ? "active" : ""}>
					Runs
				</a>
				{route.page === "run" && <span className="crumb mono">{route.id}</span>}
				{route.page === "audit" && <span className="crumb mono">audit {route.id}</span>}
			</nav>
			<main className="main">
				<Page route={route} />
			</main>
		</div>
	);
};
