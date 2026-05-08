import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

mkdirSync(distDir, { recursive: true });
cpSync(path.join(rootDir, 'index.d.ts'), path.join(distDir, 'index.d.ts'));
