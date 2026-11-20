import { readFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build, defineConfig, type Plugin } from "vite"
import solid from "vite-plugin-solid"
import { gui } from "@opencode/plugin/gui/vite"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "..")
const fakeSdk = path.join(here, "fake-sdk/index.ts")

/** Builds the stub plugin with the same `gui()` preset as the real bundle, in memory, for `?bundle=stub`. */
async function buildStubBundle(): Promise<string> {
  const result = await build({
    configFile: false,
    root: repo,
    logLevel: "warn",
    // Never written: the output stays in memory.
    plugins: [gui({ entry: path.join(here, "stub/gui.tsx"), outFile: path.join(here, ".stub/gui-experimental.cjs") })],
    build: { write: false, minify: false, sourcemap: false, target: "es2022", reportCompressedSize: false },
  })
  const outputs = Array.isArray(result) ? result : [result]
  for (const output of outputs)
    if ("output" in output)
      for (const chunk of output.output)
        if (chunk.type === "chunk" && chunk.fileName.endsWith(".cjs")) return chunk.code
  throw new Error("the stub build produced no .cjs chunk")
}

/**
 * Serves the plugin's built bundle at /dist/gui-experimental.cjs (read fresh from the repo's dist/ on every request) and
 * the stub's at /__genui/stub-bundle.cjs, in `vite` (dev) and `vite preview`.
 */
function pluginBundles(): Plugin {
  const send = (res: ServerResponse, status: number, body: string) => {
    res.statusCode = status
    res.setHeader("Content-Type", status === 200 ? "text/javascript; charset=utf-8" : "text/plain; charset=utf-8")
    res.setHeader("Cache-Control", "no-store")
    res.end(body)
  }
  const handle = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = (req.url ?? "").split("?")[0]
    if (url === "/dist/gui-experimental.cjs")
      void readFile(path.join(repo, "dist/gui-experimental.cjs"), "utf8").then(
        (code) => send(res, 200, code),
        () => send(res, 404, "dist/gui-experimental.cjs not found: run `bun run bundle` (or `vite build`) first"),
      )
    else if (url === "/__genui/stub-bundle.cjs")
      void buildStubBundle().then(
        (code) => send(res, 200, code),
        (error: unknown) => send(res, 500, `stub bundle build failed: ${String(error)}`),
      )
    else next()
  }
  return {
    name: "genui-playground-bundles",
    configureServer: (server) => void server.middlewares.use(handle),
    configurePreviewServer: (server) => void server.middlewares.use(handle),
  }
}

export default defineConfig({
  root: here,
  plugins: [solid(), pluginBundles()],
  resolve: {
    alias: [
      // The plugin's SDK resolves to the fake host's stand-in; only the exact specifiers, not ".../vite" etc.
      { find: /^@opencode\/plugin\/gui$/, replacement: fakeSdk },
      { find: /^@opencode\/plugin\/gui\/main$/, replacement: fakeSdk },
    ],
    dedupe: ["solid-js"],
  },
  optimizeDeps: {
    // Dependencies are found up front (the plugin's sources are scanned too, and the usual ones listed), so one found
    // late (src/gui.tsx loads through a glob) does not make Vite reload the page in the middle of a test.
    entries: ["index.html", "../src/gui.tsx", "../src/gui/**/*.{ts,tsx}"],
    include: [
      "solid-js",
      "solid-js/web",
      "solid-js/store",
      "effect",
      "zod",
      "@json-render/core",
      "@json-render/solid",
      "@json-render/solid/schema",
      "@json-render/directives",
      "@opencode/ui/icons/catalog",
      "@opencode/ui/theme/resolve",
      "@opencode/ui/theme/v2/resolve",
    ],
  },
  server: { port: 5178, fs: { allow: [repo] } },
  preview: { port: 5178 },
  // The playground is a dev tool; its chunk sizes do not matter.
  build: { outDir: path.join(here, "dist"), emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 4096 },
})
