// Builds the desktop app (Electron) into desktop/app: bundled main process, preload, icons and a
// minimal package.json. `electron desktop/app` runs it; electron-builder packages that folder.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { barsMotif, sealPng } from './lib/icons.mjs';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'desktop', 'app');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const common = { bundle: true, platform: 'node', target: 'node22', legalComments: 'none', logLevel: 'warning', sourcemap: false };

await build({
  ...common,
  entryPoints: [path.join(root, 'desktop', 'main.ts')],
  outfile: path.join(out, 'main.mjs'),
  format: 'esm',
  // Playwright is only needed by the CLI's bot-browser login (loaded on demand, never here).
  external: ['electron', 'playwright', 'playwright-core'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
await build({ ...common, entryPoints: [path.join(root, 'desktop', 'preload.ts')], outfile: path.join(out, 'preload.cjs'), format: 'cjs', external: ['electron'] });

fs.writeFileSync(path.join(out, 'icon.png'), sealPng(512, barsMotif));
fs.writeFileSync(path.join(out, 'tray.png'), sealPng(32, barsMotif));
fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify({ name: 'kyara-bot-desktop', productName: 'Kyara Bot', version: pkg.version, description: 'Kyara Bot desktop app', author: 'vukkywuk', license: pkg.license ?? 'MIT', main: 'main.mjs', type: 'module' }, null, 2),
);
console.log(`Desktop app built: ${path.relative(root, out)}`);
