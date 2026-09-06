class Agent {
  constructor({ name, role, capabilities = [], timeoutMs = 30000 }) {
    this.name = name;
    this.role = role;
    this.capabilities = capabilities;
    this.timeoutMs = timeoutMs;
    this.status = 'idle';
    this.messageCount = 0;
    this.errorCount = 0;
    this.lastActive = null;
  }

  async handle(message) {
    throw new Error(`Agent ${this.name} must implement handle()`);
  }

  info() {
    return {
      name: this.name,
      role: this.role,
      capabilities: this.capabilities,
      timeoutMs: this.timeoutMs,
      status: this.status,
      messageCount: this.messageCount,
      errorCount: this.errorCount,
      lastActive: this.lastActive,
    };
  }
}

export { Agent };
