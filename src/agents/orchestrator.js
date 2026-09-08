import { createMessage, createResult, ResultStatus, createAuditEntry } from './message.js';
import { Registry } from './registry.js';
import { RiskEngine } from './risk.js';
import { SagaRunner } from './saga.js';
import { randomUUID } from 'node:crypto';

const MAX_LOG_SIZE = 1000;
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24h default

class Orchestrator {
  constructor({ db } = {}) {
    this.db = db;
    this.registry = new Registry();
    this.risk = new RiskEngine();
    this.saga = new SagaRunner({ db });
    this.log = [];
    this.dedupTtlMs = DEDUP_TTL_MS;
  }

  // Purge dedup entries older than the TTL. Best-effort; no-op without a db.
  async _purgeStaleDedup() {
    if (!this.db) return;
    const cutoff = new Date(Date.now() - this.dedupTtlMs).toISOString();
    await this.db.run('DELETE FROM message_dedup WHERE processed_at < ?', [cutoff]);
  }

  register(agent, domains) {
    this.registry.register(agent, domains);
  }

  async _isDuplicate(messageId) {
    if (!this.db || !messageId) return false;
    const row = await this.db.get('SELECT message_id FROM message_dedup WHERE message_id = ?', [messageId]);
    return !!row;
  }

  async _recordMessage(messageId, result) {
    if (!this.db || !messageId) return;
    await this.db.run(
      'INSERT OR REPLACE INTO message_dedup (message_id, result, processed_at) VALUES (?, ?, ?)',
      [messageId, JSON.stringify(result), new Date().toISOString()]
    );
  }

  async _getCachedResult(messageId) {
    if (!this.db || !messageId) return null;
    const row = await this.db.get('SELECT result FROM message_dedup WHERE message_id = ?', [messageId]);
    return row?.result ? JSON.parse(row.result) : null;
  }

  async send(message) {
    await this._purgeStaleDedup();
    const dedupResult = await this._getCachedResult(message.id);
    if (dedupResult) return dedupResult;

    const agent = this.registry.lookup(message.domain) || this.registry.get(message.to);
    if (!agent) return createResult({ status: ResultStatus.FAILURE, error: `No agent for domain "${message.domain}" or target "${message.to}"` });

    this.log.push({ ...message, direction: 'inbound' });
    if (this.log.length > MAX_LOG_SIZE) this.log = this.log.slice(-MAX_LOG_SIZE);

    agent.status = 'processing';
    agent.messageCount++;
    agent.lastActive = Date.now();

    try {
      const timeoutMs = agent.timeoutMs || 30000;
      let result = await Promise.race([
        agent.handle(message),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('AGENT_TIMEOUT')), timeoutMs)
        ),
      ]);

      result = this.risk.evaluate(result, message);

      if (result.status === ResultStatus.PENDING_APPROVAL) {
        const approvalId = randomUUID();
        if (this.db) {
          await this.db.run(
            `INSERT INTO approval_queue (id, message_id, agent_name, action, detail, risk_score, requested_by, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
            [
              approvalId,
              message.id,
              agent.name,
              message.domain,
              JSON.stringify(result.data),
              result.risk?.score ?? null,
              message.from || 'system',
              new Date().toISOString(),
            ]
          );
        }
        result.approvalId = approvalId;
      }

      this.log.push({ ...message, direction: 'outbound', result: result.status });
      if (this.log.length > MAX_LOG_SIZE) this.log = this.log.slice(-MAX_LOG_SIZE);

      await this._recordMessage(message.id, result);
      return result;
    } catch (err) {
      agent.errorCount++;
      const errorResult = createResult({
        status: ResultStatus.FAILURE,
        error: err.message,
        audit: [createAuditEntry(agent.name, 'ERROR', err.message)],
      });
      await this._recordMessage(message.id, errorResult);
      return errorResult;
    } finally {
      agent.status = 'idle';
    }
  }

  async flow(steps) {
    const sagaSteps = steps.map(s => ({
      domain: s.domain || 'unknown',
      payload: s.payload || {},
      timeoutMs: s.timeoutMs,
      execute: async () => {
        const msg = createMessage(s);
        const result = await this.send(msg);
        if (result.status === ResultStatus.FAILURE) throw new Error(result.error);
        if (result.status === ResultStatus.PENDING_APPROVAL) throw new Error('PENDING_APPROVAL');
        return result;
      },
      compensate: s.compensate ? async () => {
        const msg = createMessage({ ...s.compensate, type: 'COMMAND' });
        await this.send(msg);
      } : undefined,
    }));
    return this.saga.run(sagaSteps);
  }

  async approve(approvalId, decidedBy) {
    if (this.db) {
      await this.db.run(
        "UPDATE approval_queue SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
        [decidedBy, new Date().toISOString(), approvalId]
      );
    }
    return { approvalId, status: 'approved', decidedBy };
  }

  async reject(approvalId, decidedBy, reason) {
    if (this.db) {
      await this.db.run(
        "UPDATE approval_queue SET status = 'rejected', decided_by = ?, decided_at = ?, reason = ? WHERE id = ? AND status = 'pending'",
        [decidedBy, new Date().toISOString(), reason || null, approvalId]
      );
    }
    return { approvalId, status: 'rejected', decidedBy, reason };
  }

  agents() { return this.registry.list(); }
  history(limit = 50) { return this.log.slice(-limit); }
}

export { Orchestrator };
