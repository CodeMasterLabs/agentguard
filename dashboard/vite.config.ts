import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Inline the entry stylesheet into index.html. The page cannot paint before its CSS arrives,
 * so a separate file costs a full round trip on first load (Lighthouse: render-blocking).
 * Asset URLs inside it are absolute (/assets/...), so they resolve the same from the HTML.
 */
function inlineEntryCss(): Plugin {
  return {
    name: "agentguard:inline-entry-css",
    apply: "build",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return html;
        return html.replace(/<link rel="stylesheet"[^>]*href="\/(assets\/[^"]+\.css)"[^>]*>/g, (tag, file: string) => {
          const asset = bundle[file];
          if (!asset || asset.type !== "asset") return tag;
          delete bundle[file];
          return `<style>${String(asset.source)}</style>`;
        });
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), inlineEntryCss()],
  server: { port: 5173 },
});
