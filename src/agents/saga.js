import { randomUUID } from 'node:crypto';

class SagaRunner {
  constructor({ db } = {}) {
    this.db = db;
  }

  generateSagaId() {
    return randomUUID();
  }

  async _persistLog(sagaId, stepIndex, status, domain, payload, result) {
    if (!this.db) return;
    if (status === 'executing') {
      await this.db.run(
        'INSERT INTO saga_log (id, saga_id, step_index, status, domain, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [randomUUID(), sagaId, stepIndex, status, domain, JSON.stringify(payload), new Date().toISOString()]
      );
    } else {
      await this.db.run(
        'UPDATE saga_log SET status = ?, result = ? WHERE saga_id = ? AND step_index = ?',
        [status, result ? JSON.stringify(result) : null, sagaId, stepIndex]
      );
    }
  }

  async _withTimeout(fn, timeoutMs) {
    if (!timeoutMs) return fn();
    return Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Step timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }

  async run(steps) {
    const sagaId = this.generateSagaId();
    const executed = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      try {
        await this._persistLog(sagaId, i, 'executing', step.domain || 'unknown', step.payload || {});
        const result = await this._withTimeout(
          () => step.execute(),
          step.timeoutMs
        );
        await this._persistLog(sagaId, i, 'completed', step.domain || 'unknown', step.payload || {}, result);
        executed.push(i);
      } catch (err) {
        await this._persistLog(sagaId, i, 'failed', step.domain || 'unknown', step.payload || {}, { error: err.message });
        for (let j = executed.length - 1; j >= 0; j--) {
          try {
            await this._persistLog(sagaId, j, 'compensating', steps[j].domain || 'unknown', steps[j].payload || {});
            await steps[j].compensate?.();
            await this._persistLog(sagaId, j, 'compensated', steps[j].domain || 'unknown', steps[j].payload || {});
          } catch (_) {
            await this._persistLog(sagaId, j, 'compensation_failed', steps[j].domain || 'unknown', steps[j].payload || {}).catch(() => {});
          }
        }
        return { ok: false, sagaId, rolledBackAt: i, error: err.message, stepsCompleted: executed.length };
      }
    }

    await this._persistLog(sagaId, -1, 'completed', '__saga__', {});
    return { ok: true, sagaId, stepsCompleted: executed.length };
  }
}

export { SagaRunner };
