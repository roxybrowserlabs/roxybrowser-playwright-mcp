#!/usr/bin/env node
/**
 * 全量打包我们代码 + playwright + playwright-core（已 patch），仅 external chromium-bidi 子路径。
 * 后处理：注入 createRequire 使 bundle 内 require('fs') 等可用。
 */
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

await esbuild.build({
  entryPoints: ['src/cli.js', 'src/index.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: '/* @roxybrowser/playwright-mcp bundle */',
  },
  minify: false,
  sourcemap: true,
  target: 'node18',
});

// 后处理：注入 createRequire 与 __dirname（ESM 无 __dirname），替换 __require
const injectLines = [
  "import { createRequire as __createRequire } from 'node:module';",
  "import { fileURLToPath } from 'node:url';",
  "import { dirname as __pathDirname } from 'node:path';",
  "var __dirname = __pathDirname(fileURLToPath(import.meta.url));",
  "",
].join('\n');
const __requireBlock = /var __require = \/\* @__PURE__ \*\/ \(\(x\) => typeof require !== "undefined"[\s\S]*?throw Error\('Dynamic require of "[^"]+" is not supported'\);\s*\}\);/;
for (const name of ['cli.mjs', 'index.mjs']) {
  const outPath = join(__dirname, 'dist', name);
  let code = readFileSync(outPath, 'utf8');
  if (!code.includes('__createRequire')) {
    const firstLineEnd = code.indexOf('\n') + 1;
    code = code.slice(0, firstLineEnd) + injectLines + code.slice(firstLineEnd);
  }
  code = code.replace(__requireBlock, 'var __require = __createRequire(import.meta.url);');
  writeFileSync(outPath, code);
}

console.log('Built dist/cli.mjs, dist/index.mjs');
