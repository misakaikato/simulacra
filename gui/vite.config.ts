// Vite config for the GUI: root and output are fixed relative to this file so the build works
// from the repository root, and /api is proxied to a local `simulacra serve` (or dev-mock) on
// port 8787.
// GUI 的 Vite 配置：root 与输出目录相对本文件固定，从仓库根构建也能工作；/api 代理到本机
// 8787 端口的 `simulacra serve`（或 dev-mock）。

import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
	root: here("."),
	cacheDir: here("../node_modules/.vite"),
	plugins: [react()],
	build: { outDir: here("./dist"), emptyOutDir: true },
	server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
