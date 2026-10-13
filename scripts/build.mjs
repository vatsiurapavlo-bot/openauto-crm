/**
 * Budowanie: interfejs (React → dist/public) i serwer (→ dist/server).
 *   node scripts/build.mjs          — produkcja
 *   node scripts/build.mjs --watch  — tryb deweloperski (tylko interfejs)
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const watch = process.argv.includes('--watch');
const out = path.resolve('dist');
const pub = path.join(out, 'public');

fs.rmSync(pub, { recursive: true, force: true });
fs.mkdirSync(path.join(pub, 'assets'), { recursive: true });

function copyDir(src, dst) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyDir(s, d);
    } else fs.copyFileSync(s, d);
  }
}

function writeShell(result) {
  const outputs = Object.keys(result.metafile.outputs).map((p) => '/' + path.relative(pub, p).replaceAll(path.sep, '/'));
  const js = outputs.find((p) => p.endsWith('.js'));
  const css = outputs.find((p) => p.endsWith('.css'));
  const html = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#121417">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="OpenAuto">
<meta name="robots" content="noindex, nofollow">
<title>OpenAuto CRM</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
${css ? `<link rel="stylesheet" href="${css}">` : ''}
</head>
<body>
<div id="root"></div>
<noscript>OpenAuto CRM wymaga włączonego JavaScriptu.</noscript>
<script type="module" src="${js}"></script>
</body>
</html>
`;
  fs.writeFileSync(path.join(pub, 'index.html'), html);
  const buildId = crypto.createHash('sha256').update(outputs.join('|')).digest('hex').slice(0, 12);
  const sw = fs
    .readFileSync('public/sw.js', 'utf8')
    .replace('__BUILD_ID__', buildId)
    .replace('__ASSETS__', outputs.map((o) => JSON.stringify(o)).join(', '));
  fs.writeFileSync(path.join(pub, 'sw.js'), sw);
}

copyDir('public', pub);

const clientOptions = {
  entryPoints: ['src/client/main.tsx'],
  bundle: true,
  format: 'esm',
  splitting: false,
  outdir: path.join(pub, 'assets'),
  entryNames: 'app-[hash]',
  assetNames: '[name]-[hash]',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  target: ['es2022', 'safari15', 'chrome100'],
  jsx: 'automatic',
  metafile: true,
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context({
    ...clientOptions,
    plugins: [{ name: 'shell', setup: (b) => b.onEnd((r) => r.metafile && writeShell(r)) }],
  });
  await ctx.watch();
} else {
  const client = await esbuild.build(clientOptions);
  writeShell(client);

  // Serwer i narzędzia CLI — pojedyncze pliki ESM; `pg` ładowany z node_modules
  await esbuild.build({
    entryPoints: {
      main: 'src/server/main.ts',
      start: 'src/server/start.ts',
      restore: 'src/server/cli/restore.ts',
      migrate: 'src/server/cli/migrate.ts',
      setup: 'src/server/cli/setup.ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outdir: path.join(out, 'server'),
    external: ['pg'],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: 'info',
  });
  console.log('Gotowe: dist/public (interfejs), dist/server (serwer)');
}
