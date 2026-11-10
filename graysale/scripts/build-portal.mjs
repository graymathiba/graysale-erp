// Build the static online portal for Render (or any static host).
// Render runs this in its build step with SUPABASE_URL and SUPABASE_ANON_KEY.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sourceDir = new URL('../cloud-portal/', import.meta.url);
const outputDir = new URL('../cloud-portal/dist/', import.meta.url);
const supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();

if (!supabaseUrl || !anonKey) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required to build the portal.');
  process.exit(1);
}

const config = JSON.stringify({ supabaseUrl, anonKey });
const source = await readFile(new URL('index.html', sourceDir), 'utf8');
if (!source.includes('__GRAYSALE_CLOUD_CONFIG__')) {
  console.error('cloud-portal/index.html is missing the __GRAYSALE_CLOUD_CONFIG__ placeholder.');
  process.exit(1);
}

const html = source.replace('__GRAYSALE_CLOUD_CONFIG__', config);
await mkdir(outputDir, { recursive: true });
await writeFile(new URL('index.html', outputDir), html);
await writeFile(new URL('robots.txt', outputDir), 'User-agent: *\nDisallow: /\n');

console.log(`Portal built: ${fileURLToPath(outputDir)}`);
