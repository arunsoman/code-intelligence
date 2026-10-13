import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Zod v4 ships comments with @__PURE__ annotations in positions Rollup does
// not expect. Rollup removes the comments and emits a warning for each file.
// The comments are purely informational; suppressing the noise keeps the
// build output readable.
function suppressZodAnnotationWarnings(warning, warn) {
  if (
    warning.code === "INVALID_ANNOTATION" &&
    warning.id &&
    /node_modules\/zod\/v4\/core\/(regexes|util)\.js$/.test(warning.id)
  ) {
    return;
  }
  warn(warning);
}

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:4317" } },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      onwarn: suppressZodAnnotationWarnings,
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
        },
      },
    },
  },
});
