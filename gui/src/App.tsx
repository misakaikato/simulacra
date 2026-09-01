import { useEffect, useState } from "react";
import { Runs } from "./pages/Runs";

type Route = { readonly page: "runs" } | { readonly page: "missing"; readonly hash: string };

const parseRoute = (hash: string): Route => {
	const parts = hash
		.replace(/^#\/?/, "")
		.split("/")
		.filter((p) => p !== "")
		.map(decodeURIComponent);
	const [head] = parts;
	if (head === undefined || (head === "runs" && parts.length === 1)) return { page: "runs" };
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
			</nav>
			<main className="main">
				<Page route={route} />
			</main>
		</div>
	);
};
