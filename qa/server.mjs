// QA only: tiny static server for qa/pages + bundled harness. `node qa/server.mjs` → http://localhost:5179/pages/test.html
import esbuild from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve(import.meta.dirname);
const port = Number(process.env.PORT) || 5179;

await esbuild.build({
  entryPoints: [path.join(root, 'harness.ts')],
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  outfile: path.join(root, 'dist/harness.js'),
  sourcemap: 'inline',
  logLevel: 'warning',
});

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`QA server: http://localhost:${port}/pages/test.html`));
