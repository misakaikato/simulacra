// Mounts App into #root under StrictMode; styles.css is imported here so Vite bundles it.
// 在 StrictMode 下把 App 挂到 #root；styles.css 在此导入以便 Vite 打包。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (root !== null)
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
