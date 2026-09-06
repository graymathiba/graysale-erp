import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RiskEngine } from '../src/agents/risk.js';
import { createResult, ResultStatus, createMessage, createAuditEntry } from '../src/agents/message.js';
import { Orchestrator } from '../src/agents/orchestrator.js';

test('risk engine scores a low-risk action below threshold', () => {
  const risk = new RiskEngine();
  const s = risk.score(0.1, 0.2, 0.9);
  assert.equal(s.requiresApproval, false);
  assert.ok(s.value < 0.75);
});

test('risk engine scores high financial impact as requiring approval', () => {
  const risk = new RiskEngine();
  const s = risk.score(1.0, 0.6, 0.4);
  assert.equal(s.requiresApproval, true);
});

test('risk score formula matches ERP spec weights', () => {
  const risk = new RiskEngine();
  const financial = 0.5, sensitivity = 0.3, confidence = 0.8;
  const expected = Math.round((0.5 * financial + 0.3 * sensitivity + 0.2 * (1 - confidence)) * 1000) / 1000;
  assert.equal(risk.score(financial, sensitivity, confidence).value, expected);
});

test('risk engine respects custom threshold', () => {
  // score = 0.5*financial + 0.3*sensitivity + 0.2*(1-confidence)
  // 0.5*1.0 + 0.3*0.6 + 0.2*(1-0.4) = 0.5 + 0.18 + 0.12 = 0.8
  const risk = new RiskEngine({ approvalThreshold: 0.5 });
  const s = risk.score(1.0, 0.6, 0.4);
  assert.equal(s.requiresApproval, true);
  const risk2 = new RiskEngine({ approvalThreshold: 0.99 });
  const s2 = risk2.score(1.0, 0.6, 0.4);
  assert.equal(s2.requiresApproval, false);
});

// A gated agent returns a high-risk result with a precomputed risk payload.
class GatedAgent {
  constructor() {
    this.name = 'GATED';
    this.status = 'idle';
    this.messageCount = 0;
    this.errorCount = 0;
  }
  info() { return { name: this.name, status: this.status, messageCount: this.messageCount, errorCount: this.errorCount, capabilities: [] }; }
  async handle() {
    return createResult({ data: { big: true }, risk: { value: 0.9, requiresApproval: true }, audit: [createAuditEntry('gated', 'do', 'high risk')] });
  }
}

test('orchestrator gates high-risk results to PENDING_APPROVAL', async () => {
  const orchObj = new Orchestrator();
  const gated = new GatedAgent();
  orchObj.register(gated, ['gate']);
  const msg = createMessage({ type: 'QUERY', from: 'test', to: '', domain: 'gate.do' });
  const res = await orchObj.send(msg);
  assert.equal(res.status, ResultStatus.PENDING_APPROVAL);
  assert.ok(res.audit.some(a => a.agent === 'risk-engine'));
});

test('low-risk results pass through unchanged', async () => {
  const orchObj = new Orchestrator();
  const gated = new GatedAgent();
  gated.handle = async () => createResult({ data: 42 });
  orchObj.register(gated, ['gate']);
  const res = await orchObj.send(createMessage({ type: 'QUERY', from: 'test', to: '', domain: 'gate.thing' }));
  assert.equal(res.status, ResultStatus.SUCCESS);
  assert.equal(res.data, 42);
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

test('risk engine evaluate modifies result status in place', () => {
  const risk = new RiskEngine();
  const result = createResult({
    data: 'test',
    risk: { value: 0.85, requiresApproval: true },
    audit: [createAuditEntry('test', 'action', 'detail')],
  });
  const msg = createMessage({ type: 'QUERY', from: 't', domain: 'x' });
  const evaluated = risk.evaluate(result, msg);
  assert.equal(evaluated.status, ResultStatus.PENDING_APPROVAL);
  assert.ok(evaluated.audit.some(a => a.agent === 'risk-engine'));
});

test('risk engine evaluate does not modify low-risk results', () => {
  const risk = new RiskEngine();
  const result = createResult({ data: 'safe' });
  const msg = createMessage({ type: 'QUERY', from: 't', domain: 'x' });
  const evaluated = risk.evaluate(result, msg);
  assert.equal(evaluated.status, ResultStatus.SUCCESS);
});
