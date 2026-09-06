import { ResultStatus, createAuditEntry } from './message.js';

class RiskEngine {
  constructor({ approvalThreshold = 0.75 } = {}) {
    this.approvalThreshold = approvalThreshold;
  }

  score(financialImpact = 0, sensitivity = 0, confidence = 1) {
    const r = 0.5 * financialImpact + 0.3 * sensitivity + 0.2 * (1 - confidence);
    return { value: Math.round(r * 1000) / 1000, requiresApproval: r >= this.approvalThreshold };
  }

  evaluate(result, message) {
    if (result.risk?.requiresApproval) {
      result.status = ResultStatus.PENDING_APPROVAL;
      result.audit.push(createAuditEntry('risk-engine', 'GATED', `Risk score ${result.risk.value} exceeds threshold`));
    }
    return result;
  }
}

export { RiskEngine };
