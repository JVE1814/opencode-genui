import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// Builds src/gui.tsx into the one CommonJS file the desktop app loads (exports["./gui-experimental"]).
export default defineConfig({
  plugins: [gui()],
  build: {
    minify: "esbuild",
    sourcemap: false,
    target: "es2022",
    reportCompressedSize: false,
    rollupOptions: {
      onwarn(warning, warn) {
        // zod ships /*#__PURE__*/ annotations in positions Rollup cannot use; harmless.
        if (warning.code === "INVALID_ANNOTATION") return
        warn(warning)
      },
    },
  },
})
