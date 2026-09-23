import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "html-transform",
      transformIndexHtml(html: string) {
        return html
          .replace(/<script type="module" crossorigin/g, "<script defer")
          .replace(/<link rel="modulepreload"[^>]*>/g, "");
      },
    },
  ],
  clearScreen: false,
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "esnext",
    outDir: "dist",
    assetsDir: "assets",
    rollupOptions: {
      output: {
        format: "iife",
        name: "ModuleLoomApp",
        inlineDynamicImports: true,
        entryFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
