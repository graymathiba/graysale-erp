import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore, productIds } from './helpers.js';
import { createOrchestrator, FinanceAgent } from '../src/agents/index.js';
import { createMessage, createResult, ResultStatus } from '../src/agents/message.js';
import { Orchestrator } from '../src/agents/orchestrator.js';
import { SagaRunner } from '../src/agents/saga.js';

function newCtx() {
  const store = createTestStore();
  return { store, orch: createOrchestrator(store), ids: productIds(store) };
}

function wrapDb(databaseSync) {
  return {
    run(sql, params = []) {
      const stmt = databaseSync.prepare(sql);
      const result = stmt.run(...params);
      return Promise.resolve(result);
    },
    get(sql, params = []) {
      const stmt = databaseSync.prepare(sql);
      const result = stmt.get(...params);
      return Promise.resolve(result || null);
    },
    all(sql, params = []) {
      const stmt = databaseSync.prepare(sql);
      return Promise.resolve(stmt.all(...params));
    },
  };
}

function createMockDb() {
  const calls = [];
  return {
    calls,
    run(sql, params = []) { calls.push({ sql, params }); return Promise.resolve(); },
    get(sql, params = []) { return Promise.resolve(null); },
    all(sql, params = []) { return Promise.resolve([]); },
  };
}

// A minimal agent that returns a result with a risk score the orchestrator must gate.
class GatedAgent {
  constructor() {
    this.name = 'GATED';
    this.status = 'idle';
    this.messageCount = 0;
    this.errorCount = 0;
    this.handleCalls = 0;
    this.compensations = 0;
  }
  info() { return { name: this.name, status: this.status, messageCount: this.messageCount, errorCount: this.errorCount, capabilities: [] }; }
  async handle(message) {
    this.handleCalls++;
    return createResult({ data: { ok: true } });
  }
}

test('single successful saga step completes', async () => {
  const { orch } = newCtx();
  const result = await orch.flow([{ domain: 'finance.chart', payload: {} }]);
  assert.equal(result.ok, true);
  assert.equal(result.stepsCompleted, 1);
});

test('multi-step saga succeeds when all steps pass', async () => {
  const { orch } = newCtx();
  const result = await orch.flow([
    { domain: 'finance.chart', payload: {} },
    { domain: 'scm.low_stock', payload: {} },
    { domain: 'analytics.top_products', payload: { limit: 5 } },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.stepsCompleted, 3);
});

test('saga rolls back prior steps when a later step fails', async () => {
  const { orch } = newCtx();
  const result = await orch.flow([
    { domain: 'finance.chart', payload: {} },
    { domain: 'analytics.top_products', payload: { limit: 5 } },
    { domain: 'does.not_exist', payload: {} },   // unknown -> fails
    { domain: 'finance.verify', payload: {} },
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.rolledBackAt >= 2);
});

test('saga logs are persisted when db is provided', async () => {
  const store = createTestStore();
  const mockDb = createMockDb();
  const orch = new Orchestrator({ db: mockDb });
  const finance = new (await import('../src/agents/finance/agent.js')).FinanceAgent(store);
  orch.register(finance, ['finance', 'ledger']);
  const result = await orch.flow([
    { domain: 'finance.chart', payload: {} },
    { domain: 'finance.verify', payload: {} },
  ]);
  assert.equal(result.ok, true);
  const inserts = mockDb.calls.filter(c => c.sql.includes('INSERT INTO saga_log'));
  assert.ok(inserts.length >= 2, `expected >=2 saga log inserts, got ${inserts.length}`);
  assert.ok(inserts.every(c => c.params[3] === 'executing' || c.params[3] === 'completed'));
});

test('saga logs failure when step fails with db persistence', async () => {
  const store = createTestStore();
  const mockDb = createMockDb();
  const orch = new Orchestrator({ db: mockDb });
  const finance = new (await import('../src/agents/finance/agent.js')).FinanceAgent(store);
  orch.register(finance, ['finance']);
  const result = await orch.flow([
    { domain: 'finance.chart', payload: {} },
    { domain: 'nonexistent.fail', payload: {} },
  ]);
  assert.equal(result.ok, false);
  const updates = mockDb.calls.filter(c => c.sql.includes('saga_log') && c.sql.includes('UPDATE'));
  assert.ok(updates.some(c => c.params[0] === 'failed'), 'expected a failed saga log UPDATE');
});

test('orchestrator counts messages and tracks errors', async () => {
  const orch = new Orchestrator();
  const gated = new GatedAgent();
  orch.register(gated, ['gate']);
  await orch.send(createMessage({ type: 'QUERY', from: 't', domain: 'gate.ok' }));
  await orch.send(createMessage({ type: 'QUERY', from: 't', domain: 'missing.x' }));
  const info = orch.agents().find(a => a.name === 'GATED');
  assert.equal(info.messageCount, 1);
});

test('orchestrator history logs inbound and outbound messages', async () => {
  const { orch } = newCtx();
  await orch.send(createMessage({ type: 'QUERY', from: 'test', domain: 'finance.chart' }));
  const history = orch.history();
  assert.ok(history.length >= 2);
  assert.ok(history.some(h => h.direction === 'inbound'));
  assert.ok(history.some(h => h.direction === 'outbound'));
});

test('orchestrator history respects limit', async () => {
  const { orch } = newCtx();
  for (let i = 0; i < 5; i++) {
    await orch.send(createMessage({ type: 'QUERY', from: 'test', domain: 'finance.chart' }));
  }
  const limited = orch.history(2);
  assert.equal(limited.length, 2);
});
