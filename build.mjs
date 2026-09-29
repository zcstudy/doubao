import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

cpSync('public', 'dist', { recursive: true });

// Pages 的 _worker.js 必须是自包含单文件，import 在这里被展平
await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/_worker.js',
});
