import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
} as Parameters<typeof defineConfig>[0]);
