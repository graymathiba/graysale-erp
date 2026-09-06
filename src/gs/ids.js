import crypto from 'node:crypto';

const pad = (n) => String(n).padStart(2, '0');

const token = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

const nowIso = () => new Date().toISOString();

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const todayLocal = localDate;

const todayUtc = () => new Date().toISOString().slice(0, 10);

const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

const year = (d = new Date()) => d.getFullYear();

const month = (d = new Date()) => d.getMonth() + 1;

const day = (d = new Date()) => d.getDate();

const quarter = (d = new Date()) => Math.floor(d.getMonth() / 3) + 1;

export {
  pad,
  token,
  nowIso,
  localDate,
  todayLocal,
  todayUtc,
  dateKey,
  monthKey,
  year,
  month,
  day,
  quarter,
};