#!/usr/bin/env node
// Build the sellable Windows packages:
//
//   dist/GraySale-<version>-win-x64.zip           portable bundle (GraySale.bat)
//   dist/GraySale-<version>-desktop-win-x64.zip   Flutter desktop shell + bundled server
//   dist/KeyMaster-<version>-win-x64.zip          vendor key-management app
//
// All packages are self-contained: bundled Node.js runtime, built web UI and
// server sources - nothing to install on the customer's machine beyond the
// Visual C++ runtime Windows already has.
//
// Usage:
//   node scripts/package-win.mjs
//   node scripts/package-win.mjs --node-zip C:\cache\node-v22.18.0-win-x64.zip
//   node scripts/package-win.mjs --skip-portable | --skip-desktop | --skip-keymaster
//
// Node runtime resolution: --node-zip > NODE_WIN_ZIP env > dist/.node-cache
// download (fetched from nodejs.org on first run).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REPO = join(ROOT, '..');
const WIN_ASSETS = join(ROOT, 'package', 'win');
const DIST = join(ROOT, 'dist');
const NODE_VERSION = '22.18.0'; // matches the tested Node 22 line (.nvmrc)
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`;
const DESKTOP_RELEASE = join(REPO, 'graysale_desktop', 'build', 'windows', 'x64', 'runner', 'Release');
const KEYMASTER_RELEASE = join(REPO, 'keymaster', 'build', 'windows', 'x64', 'runner', 'Release');

const argv = process.argv.slice(2);
const argVal = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const nodeZipArg = argVal('--node-zip') || process.env.NODE_WIN_ZIP || null;

function die(msg) {
  console.error(`package-win: ${msg}`);
  process.exit(1);
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function ps(command) {
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'inherit' });
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

// A previous stage can stay locked (open console/terminal with cwd inside it).
// Never let that block a release: fall back to a fresh timestamped stage.
function ensureStage(name) {
  const stageTop = join(DIST, name);
  let base = stageTop;
  try {
    rmSync(stageTop, { recursive: true, force: true });
  } catch (e) {
    // ON WINDOWS a running copy of the app locks its DLLs (EPERM/EACCES);
    // an open console can hold EBUSY/ENOTEMPTY. Either way: never block a
    // release, stage into a fresh timestamped directory instead.
    if (!['EBUSY', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
    base = join(DIST, `${name}.build-${Date.now()}`);
    console.warn(`package-win: previous stage is locked (${e.code}) - staging into ${base}`);
  }
  for (const entry of readdirSync(DIST)) {
    if (entry.startsWith(`${name}.build-`)) {
      try {
        rmSync(join(DIST, entry), { recursive: true, force: true });
      } catch {
        /* still in use - harmless */
      }
    }
  }
  const stage = join(base, name.replace(/-win-x64$/, ''));
  mkdirSync(stage, { recursive: true });
  return { base, stage };
}

// --------------------------------------------------------- shared pieces ---
function makeStamp() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const now = new Date();
  return {
    pkg,
    version: pkg.version,
    date: now.toISOString().slice(0, 10),
    year: now.getFullYear(),
    channel: 'Stable',
    commit: gitCommit(),
  };
}

function fill(text, stamp) {
  return text
    .replaceAll('{{VERSION}}', stamp.version)
    .replaceAll('{{DATE}}', stamp.date)
    .replaceAll('{{YEAR}}', String(stamp.year))
    .replaceAll('{{CHANNEL}}', stamp.channel);
}

// Server sources: no runtime npm dependencies (node: builtins only), so
// node_modules stays home. The dev database (src/data) and logs never ship.
function copyAppSources(appRoot) {
  const skipSrc = (src) => {
    const rel = src.slice(join(ROOT, 'src').length + 1);
    const top = rel.split(sep)[0];
    return top === 'data' || top === 'node_modules' || rel.endsWith('.log') || rel.endsWith('.db');
  };
  cpSync(join(ROOT, 'src'), join(appRoot, 'src'), { recursive: true, filter: (s) => !skipSrc(s) });
  cpSync(join(ROOT, 'web', 'dist'), join(appRoot, 'web', 'dist'), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const appPkg = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    type: pkg.type,
    main: pkg.main,
    engines: pkg.engines,
    license: pkg.license,
    scripts: { start: 'node src/server.js' },
  };
  writeFileSync(join(appRoot, 'package.json'), `${JSON.stringify(appPkg, null, 2)}\n`);
}

async function resolveNodeRuntime() {
  const cacheDir = join(DIST, '.node-cache');
  let nodeZip = nodeZipArg;
  if (!nodeZip) {
    mkdirSync(cacheDir, { recursive: true });
    nodeZip = join(cacheDir, `node-v${NODE_VERSION}-win-x64.zip`);
    if (!existsSync(nodeZip)) {
      console.log(`package-win: downloading Node ${NODE_VERSION} runtime...`);
      const res = await fetch(NODE_URL);
      if (!res.ok) die(`download failed: ${res.status} ${NODE_URL}`);
      writeFileSync(`${nodeZip}.part`, Buffer.from(await res.arrayBuffer()));
      renameSync(`${nodeZip}.part`, nodeZip);
    }
  }
  if (!existsSync(nodeZip)) die(`node runtime zip not found: ${nodeZip}`);

  const unpackDir = join(cacheDir, `node-v${NODE_VERSION}`);
  mkdirSync(unpackDir, { recursive: true });
  // The official zip nests everything in a root folder (node-vX-win-x64/).
  const findNodeRoot = (dir) => {
    if (existsSync(join(dir, 'node.exe'))) return dir;
    for (const entry of readdirSync(dir)) {
      const child = join(dir, entry);
      if (statSync(child).isDirectory() && existsSync(join(child, 'node.exe'))) return child;
    }
    return null;
  };
  let nodeRoot = existsSync(join(unpackDir, 'node.exe')) ? unpackDir : null;
  if (!nodeRoot) {
    console.log('package-win: extracting node.exe...');
    ps(`Expand-Archive -Force -Path '${nodeZip}' -DestinationPath '${unpackDir}'`);
    nodeRoot = findNodeRoot(unpackDir);
  }
  if (!nodeRoot) die(`node.exe not found after extracting ${nodeZip}`);
  return nodeRoot;
}

function copyNodeRuntime(nodeDir, nodeRoot) {
  mkdirSync(nodeDir, { recursive: true });
  cpSync(join(nodeRoot, 'node.exe'), join(nodeDir, 'node.exe'));
  for (const lic of ['LICENSE', 'LICENSE.txt']) {
    if (existsSync(join(nodeRoot, lic))) {
      cpSync(join(nodeRoot, lic), join(nodeDir, lic));
      break;
    }
  }
}

function writeMeta(dir, stamp, lines = []) {
  writeFileSync(join(dir, 'EULA.txt'), fill(readFileSync(join(WIN_ASSETS, 'EULA.txt'), 'utf8'), stamp), 'utf8');
  writeFileSync(
    join(dir, 'VERSION.txt'),
    [
      `${dir.includes('KeyMaster') ? 'KeyMaster' : 'GraySale'} ${stamp.version} (${stamp.channel})`,
      `Build date:   ${stamp.date}`,
      `Git commit:   ${stamp.commit}`,
      `Node runtime: v${NODE_VERSION} (bundled, portable)`,
      `Platform:     Windows 10/11 x64`,
      ...lines,
      '',
    ].join('\r\n'),
    'utf8',
  );
}

function makeZip(stageDir, zipName) {
  const zipPath = join(DIST, zipName);
  rmSync(zipPath, { force: true });
  rmSync(`${zipPath}.sha256`, { force: true });
  console.log(`package-win: compressing ${zipName}...`);
  ps(`Compress-Archive -Force -Path '${stageDir}' -DestinationPath '${zipPath}'`);
  const zipBytes = readFileSync(zipPath);
  const sha = createHash('sha256').update(zipBytes).digest('hex');
  writeFileSync(`${zipPath}.sha256`, `${sha}  ${zipName}\n`);
  return { zipPath, bytes: zipBytes.length, sha };
}

function report(label, stageDir, zipped) {
  console.log(`  ${label.padEnd(10)}: ${zipped.zipPath}`);
  console.log(
    `  ${'staged'.padEnd(10)}: ${human(dirSize(stageDir))}   ${'archive'.padEnd(7)}: ${human(zipped.bytes)}   sha256: ${zipped.sha}`,
  );
}

// ------------------------------------------------------------ main flow ----
const stamp = makeStamp();
const version = stamp.version;

if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) die('web/dist is missing - run `npm run build:web` first.');
if (!existsSync(join(WIN_ASSETS, 'GraySale.bat'))) die(`launcher assets missing under ${WIN_ASSETS}`);

const nodeRoot = await resolveNodeRuntime();
const results = [];

// ---- 1) portable bundle (GraySale.bat) --------------------------------
if (!argv.includes('--skip-portable')) {
  const { stage } = ensureStage(`GraySale-${version}-win-x64`);
  copyAppSources(join(stage, 'app'));
  for (const name of ['GraySale.bat', 'open-browser.bat', 'Add-Firewall-Rule.bat', 'INSTALL.txt']) {
    writeFileSync(join(stage, name), fill(readFileSync(join(WIN_ASSETS, name), 'utf8'), stamp), 'utf8');
  }
  copyNodeRuntime(join(stage, 'runtime', 'node'), nodeRoot);
  writeMeta(stage, stamp);
  results.push(['portable', stage, makeZip(stage, `GraySale-${version}-win-x64.zip`)]);
}

// ---- 2) Flutter desktop shell + bundled server -------------------------
if (!argv.includes('--skip-desktop')) {
  if (!existsSync(join(DESKTOP_RELEASE, 'graysale_desktop.exe'))) {
    console.warn(
      `package-win: SKIP desktop - build it first: cd ..\\graysale_desktop && flutter build windows --release`,
    );
  } else {
    const { stage } = ensureStage(`GraySale-${version}-desktop-win-x64`);
    // Flutter Release folder (exe, dlls, flutter_assets, data)
    cpSync(DESKTOP_RELEASE, stage, { recursive: true });
    // Bundled server exactly as the shell expects it: <exeDir>\GraySaleServer
    copyAppSources(join(stage, 'GraySaleServer', 'app'));
    copyNodeRuntime(join(stage, 'GraySaleServer', 'node'), nodeRoot);
    for (const name of ['Add-Firewall-Rule.bat']) {
      writeFileSync(join(stage, name), fill(readFileSync(join(WIN_ASSETS, name), 'utf8'), stamp), 'utf8');
    }
    writeFileSync(
      join(stage, 'INSTALL.txt'),
      fill(readFileSync(join(WIN_ASSETS, 'INSTALL-DESKTOP.txt'), 'utf8'), stamp),
      'utf8',
    );
    writeMeta(stage, stamp, ['App:         graysale_desktop.exe (embedded browser + local server)']);
    results.push(['desktop', stage, makeZip(stage, `GraySale-${version}-desktop-win-x64.zip`)]);
  }
}

// ---- 3) KeyMaster vendor app -------------------------------------------
if (!argv.includes('--skip-keymaster')) {
  if (!existsSync(join(KEYMASTER_RELEASE, 'keymaster.exe'))) {
    console.warn(`package-win: SKIP keymaster - build it first: cd ..\\keymaster && flutter build windows --release`);
  } else {
    const { stage } = ensureStage(`KeyMaster-${version}-win-x64`);
    cpSync(KEYMASTER_RELEASE, stage, { recursive: true });
    writeFileSync(
      join(stage, 'INSTALL.txt'),
      fill(readFileSync(join(WIN_ASSETS, 'INSTALL-KEYMASTER.txt'), 'utf8'), stamp),
      'utf8',
    );
    writeMeta(stage, stamp, ['App:         keymaster.exe (vendor tool, needs a Control Tower instance)']);
    results.push(['keymaster', stage, makeZip(stage, `KeyMaster-${version}-win-x64.zip`)]);
  }
}

// ---------------------------------------------------------------- summary ---
if (!results.length) die('nothing was packaged.');
console.log('');
console.log(`  GraySale ${version} (${stamp.channel}) - commit ${stamp.commit}`);
for (const [label, stageDir, zipped] of results) report(label, stageDir, zipped);
console.log('');
console.log('  Smoke test each zip on a clean machine before shipping.');
