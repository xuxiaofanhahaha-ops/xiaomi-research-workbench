import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/xiaomi-research-workbench/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});
