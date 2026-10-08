import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { png } from './icons.mjs';

const watch = process.argv.includes('--watch');
// "From a link" mode (plugin tab) is ON in this version. The plugin talks to the Web2Fig server at HELPER_URL:
//   npm run build                                   → hosted server (Hugging Face Space)
//   npm run build -- --helper-url=http://localhost:5810   → a helper running on your own computer
//   npm run build -- --no-link                      → paste-only plugin (no link tab, no network)
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const LINK_MODE = !process.argv.includes('--no-link') && process.env.WEB2FIG_LINK !== '0';
const HELPER_URL = (arg('helper-url') ?? process.env.WEB2FIG_HELPER_URL ?? 'https://umangpatel2191-web2fig-helper.hf.space').replace(/\/+$/, '');
// WEB2FIG_CLOUD=1 is only for testing the hosted wording against a local copy of the server
const CLOUD = process.env.WEB2FIG_CLOUD === '1' || !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(HELPER_URL);
const dev = watch || process.argv.includes('--dev');
const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const helperDirEarly = path.join(dist, 'helper');
const ext = path.join(dist, 'extension');
const plug = path.join(dist, 'plugin');
const helperDir = path.join(dist, 'helper');
const p = (...s) => path.join(root, ...s);

// keep the helper's one-time download (node_modules) across rebuilds
for (const entry of fs.existsSync(dist) ? fs.readdirSync(dist) : []) {
  if (entry !== 'helper') fs.rmSync(path.join(dist, entry), { recursive: true, force: true });
}
for (const entry of fs.existsSync(helperDirEarly) ? fs.readdirSync(helperDirEarly) : []) {
  if (entry !== 'node_modules') fs.rmSync(path.join(helperDirEarly, entry), { recursive: true, force: true });
}
fs.mkdirSync(path.join(ext, 'icons'), { recursive: true });
fs.mkdirSync(plug, { recursive: true });
fs.mkdirSync(helperDir, { recursive: true });

const common = { bundle: true, minify: !dev, sourcemap: dev ? 'inline' : false, logLevel: 'info' };

/* ---------- icons ---------- */
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(ext, 'icons', `${s}.png`), png(s));
fs.writeFileSync(path.join(plug, 'icon-128.png'), png(128));

/* ---------- extension ---------- */
const extBuild = {
  ...common,
  entryPoints: {
    background: p('extension/src/background/index.ts'),
    content: p('extension/src/content/index.ts'),
    popup: p('extension/src/popup/popup.ts'),
    offscreen: p('extension/src/offscreen/offscreen.ts'),
  },
  outdir: ext,
  format: 'iife',
  target: 'chrome116',
};
const copyExt = () => {
  for (const f of ['manifest.json', 'popup.html', 'popup.css', 'offscreen.html'])
    fs.copyFileSync(p('extension', f), path.join(ext, f));
};

/* ---------- plugin ---------- */
const pluginMain = { ...common, entryPoints: [p('plugin/src/code.ts')], outfile: path.join(plug, 'code.js'), format: 'iife', target: 'es2017' };
const uiBuildOpts = { ...common, entryPoints: [p('plugin/src/ui/ui.ts')], write: false, format: 'iife', target: 'es2019', define: { __LINK_MODE__: String(LINK_MODE), __HELPER_URL__: JSON.stringify(HELPER_URL), __CLOUD__: String(LINK_MODE && CLOUD) } };

async function buildUi() {
  const out = await esbuild.build(uiBuildOpts);
  const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = fs.readFileSync(p('plugin/src/ui/ui.css'), 'utf8');
  const html = fs
    .readFileSync(p('plugin/src/ui/ui.html'), 'utf8')
    .replace('/*CSS*/', () => css)
    .replace('/*JS*/', () => js);
  fs.writeFileSync(path.join(plug, 'ui.html'), html);
}
const copyPlugin = () => {
  const manifest = JSON.parse(fs.readFileSync(p('plugin/manifest.json'), 'utf8'));
  // Without link mode the plugin makes no network requests at all.
  if (!LINK_MODE) manifest.networkAccess = { allowedDomains: ['none'] };
  else if (CLOUD)
    manifest.networkAccess = {
      allowedDomains: [HELPER_URL],
      reasoning: 'Link mode: the plugin sends the website address you paste to the Web2Fig server (hosted on Hugging Face), which opens the page in a browser and returns the converted layers. No Figma file data is sent.',
      devAllowedDomains: ['http://localhost:5810'],
    };
  else manifest.networkAccess = { allowedDomains: ['none'], devAllowedDomains: [HELPER_URL] };
  fs.writeFileSync(path.join(plug, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
};

/* ---------- helper (plugin “paste a link” mode) ---------- */
async function buildHelper() {
  await esbuild.build({ ...common, entryPoints: [p('helper/inject.ts')], outfile: path.join(helperDir, 'inject.js'), format: 'iife', target: 'chrome116' });
  await esbuild.build({
    ...common,
    entryPoints: [p('helper/server.ts')],
    outfile: path.join(helperDir, 'server.mjs'),
    format: 'esm',
    platform: 'node',
    target: 'node18',
    external: ['puppeteer-core'],
  });
  const pkg = JSON.parse(fs.readFileSync(p('package.json'), 'utf8'));
  fs.writeFileSync(
    path.join(helperDir, 'package.json'),
    JSON.stringify({ name: 'web2fig-helper', version: pkg.version, private: true, type: 'module', scripts: { start: 'node server.mjs' }, dependencies: { 'puppeteer-core': pkg.dependencies['puppeteer-core'] } }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(helperDir, 'Start Web2Fig Helper.bat'),
    ['@echo off', 'title Web2Fig helper', 'cd /d "%~dp0"', 'where node >nul 2>nul || (echo Node.js is required. Install it from https://nodejs.org and run this again. & pause & exit /b 1)', 'if not exist node_modules (echo First run: installing... & call npm install --omit=dev --no-audit --no-fund)', 'node server.mjs', 'pause', ''].join('\r\n'),
  );
  fs.writeFileSync(
    path.join(helperDir, 'start-web2fig-helper.command'),
    ['#!/bin/bash', 'cd "$(dirname "$0")"', 'command -v node >/dev/null || { echo "Node.js is required: https://nodejs.org"; exit 1; }', '[ -d node_modules ] || npm install --omit=dev --no-audit --no-fund', 'node server.mjs', ''].join('\n'),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(helperDir, 'README.txt'),
    `Web2Fig helper (paste-a-link mode)

What it is: a small program that runs on YOUR computer and uses YOUR Chrome (hidden) to open a website and turn it into editable layers.
The Figma plugin talks to it, so you can paste a link in the plugin instead of using the Chrome extension.

Needs: Node.js 18+ (https://nodejs.org) and Google Chrome.

Start it:   Windows: double-click  "Start Web2Fig Helper.bat"      Mac: run  start-web2fig-helper.command
            (the first run installs one small dependency, then it prints "Web2Fig helper is running")
Keep that window open while you use the plugin. Close it to stop.

Then in Figma: Plugins > Development > Web2Fig > "From a link" > paste the website address > Fetch design.

It only listens on this computer (127.0.0.1) and refuses requests from websites. Nothing is uploaded anywhere.
It cannot see pages that need you to log in, and some sites block automated browsers. For those, use the Chrome extension.
`,
  );
}

if (watch) {
  const a = await esbuild.context(extBuild);
  const b = await esbuild.context(pluginMain);
  await a.watch();
  await b.watch();
  copyExt();
  copyPlugin();
  await buildUi();
  fs.watch(p('plugin/src/ui'), { recursive: true }, () => buildUi().catch(console.error));
  fs.watch(p('extension'), { recursive: false }, copyExt);
  console.log('watching…');
} else {
  await esbuild.build(extBuild);
  await esbuild.build(pluginMain);
  copyExt();
  copyPlugin();
  await buildUi();
  if (LINK_MODE && !CLOUD) await buildHelper();
  else {
    try {
      fs.rmSync(helperDir, { recursive: true, force: true });
    } catch {
      /* a running helper locks its folder on Windows – harmless, it is not part of the store build */
    }
  }
  console.log('\nBuilt:\n  dist/extension  → chrome://extensions → Load unpacked\n  dist/plugin     → Figma → Plugins → Development → Import plugin from manifest\n  dist/helper     → run "Start Web2Fig Helper.bat" for the plugin “From a link” mode');
}
