import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const buildDir = path.join(rootDir, '.build');

mkdirSync(buildDir, { recursive: true });
cpSync(path.join(rootDir, 'package.json'), path.join(buildDir, 'package.json'));
