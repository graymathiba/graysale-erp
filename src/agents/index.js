import { Orchestrator } from './orchestrator.js';
import { FinanceAgent } from './finance/agent.js';
import { HRAgent } from './hr/agent.js';
import { SupplyChainAgent } from './supply-chain/agent.js';
import { ProcurementAgent } from './procurement/agent.js';
import { SalesAgent } from './sales/agent.js';
import { PosService } from '../pos.js';

function wrapDb(databaseSync) {
  return {
    run(sql, params = []) {
      const stmt = databaseSync.prepare(sql);
      return Promise.resolve(stmt.run(...params));
    },
    get(sql, params = []) {
      const stmt = databaseSync.prepare(sql);
      return Promise.resolve(stmt.get(...params) || null);
    },
    all(sql, params = []) {
      const stmt = databaseSync.prepare(sql);
      return Promise.resolve(stmt.all(...params));
    },
  };
}

function createOrchestrator(store, db) {
  const wrappedDb = db ? wrapDb(db) : undefined;
  const orch = new Orchestrator({ db: wrappedDb });

  const finance = new FinanceAgent(store);
  const hr = new HRAgent(store);
  const scm = new SupplyChainAgent(store);
  const proc = new ProcurementAgent(store);
  const pos = new PosService(store);
  const sales = new SalesAgent(store, pos);

  orch.register(finance, ['finance', 'ledger', 'journal', 'ar', 'ap', 'reports.trial_balance', 'reports.pl', 'reports.balance_sheet']);
  orch.register(hr, ['hr', 'employee', 'payroll', 'benefits', 'compliance']);
  orch.register(scm, ['scm', 'inventory', 'warehouse', 'logistics', 'stock']);
  orch.register(proc, ['procurement', 'po', 'vendor', 'purchase', 'invoice']);
  orch.register(sales, ['sales', 'customer', 'order', 'quote', 'analytics']);

  return orch;
}

export { createOrchestrator, Orchestrator, FinanceAgent, HRAgent, SupplyChainAgent, ProcurementAgent, SalesAgent };
