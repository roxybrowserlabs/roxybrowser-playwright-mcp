import { builtinModules } from "node:module";
import path from "node:path";

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`)
]);

export default {
  ssr: {
    noExternal: true
  },
  build: {
    target: "node22",
    sourcemap: true,
    minify: false,
    codeSplitting: false,
    emptyOutDir: false,
    outDir: "dist",
    ssr: path.resolve(__dirname, "src/bundle.ts"),
    rollupOptions: {
      external: (source) => nodeBuiltins.has(source),
      output: {
        format: "es",
        entryFileNames: "roxybrowser.bundle.js",
        inlineDynamicImports: true
      }
    }
  }
};
