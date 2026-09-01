import { useEffect, useState } from "react";
import { Run } from "./pages/Run";
import { Runs } from "./pages/Runs";

type Route =
	| { readonly page: "runs" }
	| { readonly page: "run"; readonly id: string }
	| { readonly page: "missing"; readonly hash: string };

const parseRoute = (hash: string): Route => {
	const parts = hash
		.replace(/^#\/?/, "")
		.split("/")
		.filter((p) => p !== "")
		.map(decodeURIComponent);
	const [head, id] = parts;
	if (head === undefined || (head === "runs" && parts.length === 1)) return { page: "runs" };
	if (head === "runs" && id !== undefined && parts.length === 2) return { page: "run", id };
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
			</nav>
			<main className="main">
				<Page route={route} />
			</main>
		</div>
	);
};
