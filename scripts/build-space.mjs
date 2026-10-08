// Bundles the hosted helper for a Hugging Face Gradio Space:  npm run build:space  →  dist/space/
// Everything (puppeteer-core included) is bundled into one file, so the Space never needs `npm install`.
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist', 'space');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, 'helper/inject.ts')],
  outfile: path.join(out, 'inject.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'chrome116',
  logLevel: 'warning',
});

await esbuild.build({
  entryPoints: [path.join(root, 'helper/server.ts')],
  outfile: path.join(out, 'server.mjs'),
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  // optional native speed-ups of the `ws` package; it falls back to plain JS without them
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});

for (const f of ['app.py', 'packages.txt', 'requirements.txt']) fs.copyFileSync(path.join(root, 'space-template', f), path.join(out, f));
const kb = (f) => Math.round(fs.statSync(path.join(out, f)).size / 1024);
console.log(`\nBuilt dist/space:\n  server.mjs ${kb('server.mjs')} KB, inject.js ${kb('inject.js')} KB, app.py, packages.txt, requirements.txt`);
