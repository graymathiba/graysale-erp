import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SagaRunner } from '../src/agents/saga.js';

function createMockDb() {
  const calls = [];
  return {
    calls,
    run(sql, params = []) { calls.push({ sql, params }); return Promise.resolve(); },
    get(sql, params = []) { return Promise.resolve(null); },
    all(sql, params = []) { return Promise.resolve([]); },
  };
}

test('saga runs all steps successfully', async () => {
  const saga = new SagaRunner();
  const executed = [];
  const result = await saga.run([
    { domain: 'a', execute: async () => { executed.push('a'); return 1; } },
    { domain: 'b', execute: async () => { executed.push('b'); return 2; } },
    { domain: 'c', execute: async () => { executed.push('c'); return 3; } },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.stepsCompleted, 3);
  assert.deepEqual(executed, ['a', 'b', 'c']);
});

test('saga compensates executed steps in reverse on failure', async () => {
  const saga = new SagaRunner();
  const order = [];
  const result = await saga.run([
    { domain: 'a', execute: async () => { order.push('a'); }, compensate: async () => { order.push('a-comp'); } },
    { domain: 'b', execute: async () => { order.push('b'); }, compensate: async () => { order.push('b-comp'); } },
    { domain: 'c', execute: async () => { order.push('c'); throw new Error('boom'); }, compensate: async () => { order.push('c-comp'); } },
    { domain: 'd', execute: async () => { order.push('d'); }, compensate: async () => { order.push('d-comp'); } },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.rolledBackAt, 2);
  assert.equal(result.stepsCompleted, 2);
  // a and b executed; c failed; reverse compensation b then a
  assert.deepEqual(order, ['a', 'b', 'c', 'b-comp', 'a-comp']);
});

test('saga continues after a step with no compensate defined', async () => {
  const saga = new SagaRunner();
  const order = [];
  const result = await saga.run([
    { domain: 'a', execute: async () => { order.push('a'); throw new Error('fail'); } },
    { domain: 'b', execute: async () => { order.push('b'); }, compensate: async () => { order.push('b-comp'); } },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.rolledBackAt, 0);
  // b was never executed, so nothing to compensate
  assert.deepEqual(order, ['a']);
});

test('saga enforces per-step timeout', async () => {
  const saga = new SagaRunner();
  const result = await saga.run([
    {
      domain: 'slow',
      timeoutMs: 10,
      execute: () => new Promise((_, reject) => setTimeout(() => reject(new Error('done later')), 50)),
    },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/i);
});

test('saga persists executing, completed and final log entries with db', async () => {
  const db = createMockDb();
  const saga = new SagaRunner({ db });
  const result = await saga.run([
    { domain: 'x', payload: { p: 1 }, execute: async () => 'ok' },
  ]);
  assert.equal(result.ok, true);
  // For a single successful step: 1 executing INSERT + a completed UPDATE for
  // the step + a completed UPDATE for the __saga__ final entry.
  const inserts = db.calls.filter(c => c.sql.includes('INSERT INTO saga_log'));
  assert.ok(inserts.length === 1, `expected 1 insert, got ${inserts.length}`);
  assert.equal(inserts[0].params[3], 'executing');
  const updates = db.calls.filter(c => c.sql.includes('saga_log') && c.sql.includes('UPDATE'));
  assert.ok(updates.length === 2, `expected 2 updates, got ${updates.length}`);
  assert.ok(updates.every(c => c.params[0] === 'completed'));
});

test('saga persists compensation log entries on rollback with db', async () => {
  const db = createMockDb();
  const saga = new SagaRunner({ db });
  const result = await saga.run([
    { domain: 'a', payload: {}, execute: async () => 'ok', compensate: async () => {} },
    { domain: 'b', payload: {}, execute: async () => { throw new Error('fail'); }, compensate: async () => {} },
  ]);
  assert.equal(result.ok, false);
  const compensation = db.calls.filter(c =>
    (c.sql.includes('saga_log') && c.params[0] === 'compensating') ||
    (c.sql.includes('saga_log') && c.params[0] === 'compensated')
  );
  assert.ok(compensation.length >= 2, `expected compensating+compensated entries, got ${compensation.length}`);
});

test('saga continues executing remaining steps only when all succeed', async () => {
  const saga = new SagaRunner();
  let executed = 0;
  const result = await saga.run([
    { domain: 'a', execute: async () => { executed++; } },
    { domain: 'b', execute: async () => { executed++; } },
  ]);
  assert.equal(result.ok, true);
  assert.equal(executed, 2);
});
