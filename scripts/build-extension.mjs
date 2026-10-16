// Reproducible build of the browser extension into extension/dist (load it unpacked).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeMotif, sealPng } from './lib/icons.mjs';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'extension', 'src');
const out = path.join(root, 'extension', 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });

const common = { bundle: true, target: 'chrome116', minify: false, sourcemap: false, legalComments: 'none', logLevel: 'warning' };
await build({ ...common, entryPoints: [path.join(src, 'background.ts')], outfile: path.join(out, 'background.js'), format: 'esm' });
await build({ ...common, entryPoints: [path.join(src, 'popup.ts')], outfile: path.join(out, 'popup.js'), format: 'esm' });
// Content scripts cannot be ES modules.
await build({ ...common, entryPoints: [path.join(src, 'content.ts')], outfile: path.join(out, 'content.js'), format: 'iife' });

fs.copyFileSync(path.join(root, 'extension', 'manifest.json'), path.join(out, 'manifest.json'));
fs.copyFileSync(path.join(src, 'popup.html'), path.join(out, 'popup.html'));
fs.copyFileSync(path.join(src, 'popup.css'), path.join(out, 'popup.css'));

for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(out, 'icons', `${s}.png`), sealPng(s, bridgeMotif));
console.log(`Extension built: ${path.relative(root, out)}`);
