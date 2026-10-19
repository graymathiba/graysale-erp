// Machine identity. A GraySale install is bound to a physical machine so we
// can detect when its data folder has been moved (USB stick, new PC) and ask
// before silently opening someone else's data.

import os from 'node:os';
import { createHash } from 'node:crypto';

// Stable fingerprint for "this computer, right now". Built from a hash of the
// hostname, MAC addresses, OS user and platform so two different machines
// never collide, while surviving reboots and network changes.
export function machineFingerprint() {
  const host = os.hostname();
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .map((n) => String(n.mac || ''))
    .filter((m) => m && m !== '00:00:00:00:00:00')
    .sort();
  const user = (os.userInfo && os.userInfo().username) || process.env.USERNAME || process.env.USER || '';
  const payload = [host, ...macs, user, process.platform, process.arch].join('|');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function machineHostname() {
  return os.hostname();
}

// Short human label for the current machine (used in the UI so users recognize
// "this PC" at a glance).
export function machineLabel() {
  return `${os.hostname()} · ${(() => {
    try {
      return os.userInfo().username;
    } catch {
      return process.env.USERNAME || 'user';
    }
  })()}`;
}

export default { machineFingerprint, machineHostname, machineLabel };
