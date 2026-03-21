/**
 * Webpack 打包，输出到 dist-webpack/，用于对比是否能把 package.json 等 JSON 内联进 bundle。
 * 对 playwright 里的 .html/.svg 等用 raw-loader 按字符串内联，避免 parse 报错；optional 依赖做 external。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import webpack from 'webpack';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

export default {
  target: 'node18',
  entry: {
    cli: './src/cli.js',
    index: './src/index.js',
  },
  output: {
    path: path.join(__dirname, 'dist'),
    filename: '[name].mjs',
    chunkFormat: 'module',
    library: { type: 'module' },
    environment: { module: true },
  },
  experiments: {
    outputModule: true,
  },
  resolve: {
    extensions: ['.js', '.mjs', '.json'],
    alias: {
      'chromium-bidi/lib/cjs/bidiMapper/BidiMapper': path.join(__dirname, 'src/stubs/empty.js'),
      'chromium-bidi/lib/cjs/cdp/CdpConnection': path.join(__dirname, 'src/stubs/empty.js'),
    },
  },
  externals: [
    ({ request }, callback) => {
      if (
        request === 'electron' ||
        request === 'electron/index.js' ||
        request === 'bufferutil' ||
        request === 'utf-8-validate' ||
        request === 'fsevents'
      ) {
        return callback(null, 'commonjs ' + request);
      }
      callback();
    },
  ],
  // module: {
  //   rules: [
  //     { test: /\.html$/i, type: 'asset/source' },
  //     { test: /\.svg$/i, type: 'asset/source' },
  //     { test: /\.css$/i, type: 'asset/source' },
  //     { test: /\.(png|ico|ttf|woff2?|eot)$/i, type: 'asset/resource' },
  //   ],
  // },
  plugins: [
    // CLI 入口需带 shebang，否则 npx 可能用编辑器打开而非执行（尤其是 scope 包）
    // 在最终产物阶段 prepend，确保在 license 注释之前
    {
      apply(compiler) {
        const SHEBANG = '#!/usr/bin/env node\n';
        compiler.hooks.thisCompilation.tap('ShebangPlugin', (compilation) => {
          compilation.hooks.processAssets.tap(
            { name: 'ShebangPlugin', stage: compilation.PROCESS_ASSETS_STAGE_OPTIMIZE + 1 },
            (assets) => {
              const name = 'cli.mjs';
              if (assets[name]) {
                const raw = assets[name].source();
                if (typeof raw === 'string' && !raw.startsWith('#!')) {
                  compilation.updateAsset(name, new (compilation.compiler.webpack.sources.RawSource)(SHEBANG + raw));
                }
              }
            }
          );
        });
      },
    },
    // 只处理 TypeScript 和 JavaScript 文件，忽略其他所有文件类型
    new webpack.IgnorePlugin({
      checkResource(resource) {
        const allowedExtensions = /\.(?:svg|html|css|ttf|png)$/i
        // 如果文件扩展名不在允许列表中，则忽略
        return allowedExtensions.test(resource)
      },
    }),
  ],
  devtool: 'source-map',
  optimization: {
    moduleIds: 'named', // 确定性模块 ID
    chunkIds: 'named', // 确定性 chunk ID
    minimize: true, // 启用代码压缩和混淆
    // minimizer: [
    //   new TerserPlugin({
    //     terserOptions: {
    //       compress: true, // 启用代码压缩
    //       mangle: true, // 混淆变量名称
    //     },
    //     extractComments: false, // 禁止生成 LICENSE.txt 文件
    //   }),
    // ],
  },
  stats: { modules: false, chunks: false },
  ignoreWarnings: [
    { module: /Critical dependency/ },
    { message: /require\.extensions/ },
  ],
};
