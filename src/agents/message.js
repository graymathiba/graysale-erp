import { randomUUID } from 'node:crypto';

const MessageType = Object.freeze({ QUERY: 'QUERY', COMMAND: 'COMMAND', EVENT: 'EVENT' });
const ResultStatus = Object.freeze({ SUCCESS: 'SUCCESS', FAILURE: 'FAILURE', PENDING_APPROVAL: 'PENDING_APPROVAL' });

function createMessage({ type, from, to, domain, payload = {}, metadata = {} }) {
  return { id: randomUUID(), type, from, to, domain, payload, metadata, timestamp: Date.now() };
}

function createResult({ status = ResultStatus.SUCCESS, data = null, error = null, risk = null, audit = [] }) {
  return { status, data, error, risk, audit, timestamp: Date.now() };
}

function createAuditEntry(agent, action, detail) {
  return { agent, action, detail, timestamp: Date.now() };
}

export { MessageType, ResultStatus, createMessage, createResult, createAuditEntry };
