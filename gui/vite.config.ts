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
