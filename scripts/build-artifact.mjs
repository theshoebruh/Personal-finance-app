// Turns the `vite build --mode artifact` output into what the Claude artifact viewer publishes:
// an HTML fragment (the viewer adds the doctype/head/body skeleton) that references the bundled
// script and stylesheet as relative supporting files.
import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';

const dir = 'dist-artifact';
const built = readFileSync(`${dir}/artifact.html`, 'utf8');
const scripts = built.match(/<script type="module"[^>]*><\/script>/g) ?? [];
const styles = built.match(/<link rel="stylesheet"[^>]*>/g) ?? [];
if (scripts.length !== 1) throw new Error(`Expected one module script, found ${scripts.length}`);

const fragment = [
  '<title>Personal Finance Hub</title>',
  '<meta name="color-scheme" content="dark" />',
  ...styles,
  '<div id="root"></div>',
  ...scripts,
  '',
].join('\n');

writeFileSync(`${dir}/index.html`, fragment);
rmSync(`${dir}/artifact.html`);
console.log(`Wrote ${dir}/index.html`);
for (const f of readdirSync(`${dir}/assets`)) console.log(`  assets/${f}`);
