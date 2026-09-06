import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore, productIds } from './helpers.js';
import { createOrchestrator } from '../src/agents/index.js';
import { createMessage } from '../src/agents/message.js';

function newOrch() {
  const store = createTestStore();
  return { store, orch: createOrchestrator(store), ids: productIds(store) };
}

async function ask(orch, domain, payload = {}, type = 'QUERY', to = '') {
  const msg = createMessage({ type, from: 'test', to, domain, payload });
  return orch.send(msg);
}

test('registers all five department agents', () => {
  const { orch } = newOrch();
  const agents = orch.agents();
  const names = agents.map(a => a.name).sort();
  assert.deepEqual(names, ['FIN_AGENT', 'HR_AGENT', 'PROC_AGENT', 'SALES_AGENT', 'SCM_AGENT']);
});

test('unknown domain routes to failure, not a crash', async () => {
  const { orch } = newOrch();
  const res = await ask(orch, 'nonsense.whatever');
  assert.equal(res.status, 'FAILURE');
  assert.ok(res.error.includes('No agent'));
});

test('reports agent list includes capabilities', () => {
  const { orch } = newOrch();
  const fin = orch.agents().find(a => a.name === 'FIN_AGENT');
  assert.ok(fin.capabilities.includes('reports.trial_balance'));
});

test('empty list command fails gracefully', () => {
  const { orch } = newOrch();
  const agents = orch.agents();
  assert.ok(Array.isArray(agents));
  assert.equal(agents.length, 5);
  for (const a of agents) {
    assert.equal(a.status, 'idle');
    assert.equal(a.messageCount, 0);
  }
});

test('createOrchestrator passes store to all agents', () => {
  const store = createTestStore();
  const orch = createOrchestrator(store);
  const agents = orch.agents();
  for (const info of agents) {
    assert.ok(info.name);
    assert.ok(info.role);
    assert.ok(Array.isArray(info.capabilities));
  }
});

test('orchestrator processes messages asynchronously', async () => {
  const { orch } = newOrch();
  const res = await ask(orch, 'finance.chart');
  assert.equal(res.status, 'SUCCESS');
  assert.ok(Array.isArray(res.data));
});

test('orchestrator tracks message count per agent', async () => {
  const { orch } = newOrch();
  await ask(orch, 'finance.get_balance', { accountCode: '1000' });
  await ask(orch, 'finance.get_balance', { accountCode: '2000' });
  const fin = orch.agents().find(a => a.name === 'FIN_AGENT');
  assert.equal(fin.messageCount, 2);
});

test('orchestrator history tracks messages', async () => {
  const { orch } = newOrch();
  await ask(orch, 'finance.chart');
  const history = orch.history();
  assert.ok(history.length >= 2); // inbound + outbound
  assert.ok(history.some(h => h.direction === 'inbound'));
  assert.ok(history.some(h => h.direction === 'outbound'));
});
