class Registry {
  constructor() {
    this.agents = new Map();
    this.domains = new Map();
  }

  register(agent, domains = []) {
    this.agents.set(agent.name, agent);
    for (const d of domains) this.domains.set(d, agent.name);
  }

  get(name) {
    return this.agents.get(name);
  }

  lookup(domain) {
    const agentName = this.domains.get(domain) || this.domains.get(domain.split('.')[0]);
    return agentName ? this.agents.get(agentName) : undefined;
  }

  list() {
    return [...this.agents.values()].map(a => a.info());
  }
}

export { Registry };
