// Storage descriptor (storage.json) at the root of the data folder.
//
// The descriptor is the backstage pass for a portable GraySale install:
//   * installedMachine — the machine that first created / adopted this folder.
//   * environment      — the machine currently using it, and whether that has
//                        been explicitly acknowledged. When it does not match
//                        the machine fingerprint AT BOOT, the app stops at a
//                        setup screen instead of silently opening foreign data.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';

export const FORMAT_VERSION = 1;
export const DESCRIPTOR_FILE = 'storage.json';

let seq = 0;
function randomId() {
  seq += 1;
  return `${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function descriptorPath(storageRoot) {
  return join(storageRoot, DESCRIPTOR_FILE);
}

export function loadInstall(storageRoot) {
  const fp = descriptorPath(storageRoot);
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

// Create or refresh the descriptor at a storage root. Writes are atomic-ish
// (temp file + rename) so a crash mid-write never corrupts the bookkeeping.
export function saveInstall(storageRoot, data, fingerprint) {
  const existing = loadInstall(storageRoot) || {};
  const dbFile = normalizeDbFile(data.dbFile || existing.dbFile || 'graysale.db');
  const next = {
    formatVersion: FORMAT_VERSION,
    id: existing.id || randomId(),
    storageRoot,
    storageKind: data.storageKind || existing.storageKind || 'local',
    dbFile,
    installedMachine: {
      machineId: fingerprint,
      hostname: os.hostname(),
      date: new Date().toISOString(),
    },
    environment: null,
    updatedAt: new Date().toISOString(),
  };
  writeFileAtomic(descriptorPath(storageRoot), JSON.stringify(next, null, 2));
  return next;
}

// Stamp the current machine as the environment owner of an existing install.
// This is exactly what happens when a moved folder is acknowledged: the data
// stays where it is, but this machine is now recorded as its home.
export function recordEnvironment(storageRoot, descriptor, fingerprint, { ready = true } = {}) {
  const next = {
    ...descriptor,
    environment: {
      machineId: fingerprint,
      hostname: os.hostname(),
      ready: Boolean(ready),
      recordedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  writeFileAtomic(descriptorPath(storageRoot), JSON.stringify(next, null, 2));
  return next;
}

// Does the descriptor's recorded environment match this machine?
export function environmentMatches(descriptor, fingerprint) {
  return !!(
    descriptor &&
    descriptor.environment &&
    descriptor.environment.machineId === fingerprint &&
    descriptor.environment.ready !== false
  );
}

export function installedMachineId(descriptor) {
  return descriptor && descriptor.installedMachine ? descriptor.installedMachine.machineId : null;
}

function normalizeDbFile(name) {
  const n = String(name || 'graysale.db');
  if (n.includes('/') || n.includes('\\')) return n.split(/[\\/]/).pop();
  return n;
}

function writeFileAtomic(fp, content) {
  mkdirSync(dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  try {
    renameSync(tmp, fp);
  } catch (e) {
    // Some platforms fail to rename over an open file; fall back to a direct
    // write so setup never hard-fails on a locked descriptor.
    writeFileSync(fp, content, 'utf8');
  }
}

export default { loadInstall, saveInstall, recordEnvironment, environmentMatches, descriptorPath, FORMAT_VERSION };
