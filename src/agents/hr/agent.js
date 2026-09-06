import { Agent } from '../agent.js';
import { createResult, createAuditEntry, ResultStatus } from '../message.js';

class HRAgent extends Agent {
  constructor(store) {
    super({
      name: 'HR_AGENT',
      role: 'Human Resources — Employees, Payroll, Benefits, Compliance',
      capabilities: [
        'employee.list', 'employee.get', 'employee.create', 'employee.update',
        'payroll.calculate', 'payroll.run', 'payroll.history',
        'benefits.enroll', 'benefits.list',
        'compliance.check',
      ],
    });
    this.store = store;
  }

  async handle(message) {
    const { domain, payload } = message;
    const action = domain.split('.').slice(1).join('.');

    switch (action) {
      case 'list': return this.listEmployees();
      case 'get': return this.getEmployee(payload);
      case 'create': return this.createEmployee(payload);
      case 'update': return this.updateEmployee(payload);
      case 'calculate': return this.calculatePayroll(payload);
      case 'run': return this.runPayroll(payload);
      case 'history': return this.payrollHistory(payload);
      case 'enroll': return this.enrollBenefits(payload);
      case 'list_benefits': return this.listBenefits(payload);
      case 'check': return this.complianceCheck();
      default: return createResult({ status: ResultStatus.FAILURE, error: `Unknown HR action: ${action}` });
    }
  }

  listEmployees() {
    const rows = this.store.db.prepare(
      'SELECT * FROM employees ORDER BY name'
    ).all();
    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'list_employees', `${rows.length} employees`)],
    });
  }

  getEmployee({ id }) {
    const row = this.store.db.prepare(
      'SELECT * FROM employees WHERE id = ?'
    ).get(id);
    return createResult({
      data: row || null,
      audit: [createAuditEntry(this.name, 'get_employee', `id=${id}`)],
    });
  }

  createEmployee({ name, role, department, hourlyRate, email, phone, hireDate }) {
    const db = this.store.db;
    const res = db.prepare(
      `INSERT INTO employees (name, role, department, hourly_rate_cents, email, phone, hire_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(name, role, department ?? null, hourlyRate ?? 0, email ?? null, phone ?? null, hireDate ?? null);

    const id = res.lastInsertRowid;
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);

    return createResult({
      data: employee,
      audit: [createAuditEntry(this.name, 'create_employee', name)],
    });
  }

  updateEmployee({ id, ...fields }) {
    const db = this.store.db;
    const allowed = ['name', 'role', 'department', 'hourly_rate_cents', 'email', 'phone', 'hire_date', 'active'];
    const sets = [];
    const vals = [];

    const fieldMap = {
      name: 'name', role: 'role', department: 'department',
      hourlyRate: 'hourly_rate_cents', email: 'email', phone: 'phone',
      hireDate: 'hire_date', active: 'active',
    };

    for (const [inputKey, dbCol] of Object.entries(fieldMap)) {
      if (inputKey in fields && allowed.includes(dbCol)) {
        sets.push(`${dbCol} = ?`);
        vals.push(fields[inputKey]);
      }
    }

    if (sets.length === 0) {
      return createResult({ data: null, audit: [createAuditEntry(this.name, 'update_employee', `id=${id} no changes`)] });
    }

    vals.push(id);
    db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    const updated = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);

    return createResult({
      data: updated,
      audit: [createAuditEntry(this.name, 'update_employee', `id=${id} fields=[${sets.map(s => s.split(' = ')[0]).join(',')}]`)],
    });
  }

  calculatePayroll({ employeeId, hours, taxRate = 0.25 }) {
    const emp = this.store.db.prepare(
      'SELECT * FROM employees WHERE id = ?'
    ).get(employeeId);

    if (!emp) {
      return createResult({ status: ResultStatus.FAILURE, error: 'EMPLOYEE_NOT_FOUND' });
    }

    const gross = Math.round(emp.hourly_rate_cents * hours);
    const tax = Math.round(gross * taxRate);
    const net = gross - tax;

    return createResult({
      data: { employeeId, name: emp.name, hourlyRate: emp.hourly_rate_cents, hours, gross, tax, net },
      audit: [createAuditEntry(this.name, 'calculate_payroll', `employee=${employeeId} gross=${gross} net=${net}`)],
    });
  }

  runPayroll({ entries, period }) {
    const db = this.store.db;
    db.exec('BEGIN');
    try {
      const results = [];
      let totalNet = 0;

      for (const e of entries) {
        let gross, tax, net, empName, empRole, hourlyRate;

        if (e.employeeId) {
          const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(e.employeeId);
          if (!emp) throw new Error(`Employee ${e.employeeId} not found`);
          hourlyRate = emp.hourly_rate_cents;
          empName = emp.name;
          empRole = emp.role;
        } else {
          hourlyRate = e.hourlyRate || 0;
          empName = e.name;
          empRole = e.role || 'unknown';
        }

        gross = Math.round(hourlyRate * e.hours);
        const taxRate = e.taxRate || 0.25;
        tax = Math.round(gross * taxRate);
        net = gross - tax;
        totalNet += net;

        db.prepare(
          `INSERT INTO payroll (employee_id, employee_name, role, hourly_rate_cents, hours, gross_cents, tax_cents, net_cents, period)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(e.employeeId ?? null, empName, empRole, hourlyRate, e.hours, gross, tax, net, period);

        results.push({ employeeId: e.employeeId ?? null, name: empName, gross, tax, net });
      }

      db.exec('COMMIT');

      const financialImpact = Math.min(totalNet / 50000, 1.0);
      const sensitivity = 0.4;
      const confidence = 0.85;
      const riskVal = 0.5 * financialImpact + 0.3 * sensitivity + 0.2 * (1 - confidence);
      const risk = {
        value: Math.round(riskVal * 1000) / 1000,
        requiresApproval: riskVal >= 0.75,
      };

      return createResult({
        data: { period, entriesProcessed: results.length, totalNet, results },
        risk,
        audit: [createAuditEntry(this.name, 'run_payroll', `period=${period} employees=${results.length} totalNet=${totalNet}`)],
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  payrollHistory({ period, employeeId } = {}) {
    const db = this.store.db;
    const conditions = [];
    const params = [];

    if (period) {
      conditions.push('p.period = ?');
      params.push(period);
    }
    if (employeeId) {
      conditions.push('p.employee_id = ?');
      params.push(employeeId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT p.*, e.name AS employee_name_db
       FROM payroll p
       LEFT JOIN employees e ON e.id = p.employee_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT 100`
    ).all(...params);

    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'payroll_history', `${rows.length} records`)],
    });
  }

  enrollBenefits({ employeeId, planName, provider, monthlyCost, employerContribution }) {
    const db = this.store.db;
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
    if (!emp) {
      return createResult({ status: ResultStatus.FAILURE, error: 'EMPLOYEE_NOT_FOUND' });
    }

    const res = db.prepare(
      `INSERT INTO benefits (employee_id, plan_name, provider, monthly_cost_cents, employer_contribution_cents)
       VALUES (?, ?, ?, ?, ?)`
    ).run(employeeId, planName, provider ?? null, monthlyCost ?? 0, employerContribution ?? 0);

    const benefit = db.prepare('SELECT * FROM benefits WHERE id = ?').get(res.lastInsertRowid);

    return createResult({
      data: benefit,
      audit: [createAuditEntry(this.name, 'enroll_benefits', `employee=${employeeId} plan=${planName}`)],
    });
  }

  listBenefits({ employeeId } = {}) {
    const db = this.store.db;
    let rows;
    if (employeeId) {
      rows = db.prepare(
        'SELECT b.*, e.name AS employee_name FROM benefits b JOIN employees e ON e.id = b.employee_id WHERE b.employee_id = ? ORDER BY b.enrolled_at DESC'
      ).all(employeeId);
    } else {
      rows = db.prepare(
        'SELECT b.*, e.name AS employee_name FROM benefits b JOIN employees e ON e.id = b.employee_id ORDER BY b.enrolled_at DESC'
      ).all();
    }

    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'list_benefits', `${rows.length} benefits`)],
    });
  }

  complianceCheck() {
    const db = this.store.db;
    const totalActive = db.prepare('SELECT COUNT(*) AS c FROM employees WHERE active = 1').get().c;
    const withBenefits = db.prepare(
      `SELECT COUNT(DISTINCT employee_id) AS c FROM benefits WHERE status = 'active'`
    ).get().c;
    const withoutBenefits = totalActive - withBenefits;

    const missingBenefits = db.prepare(
      `SELECT e.id, e.name, e.role, e.department
       FROM employees e
       WHERE e.active = 1 AND e.id NOT IN (
         SELECT DISTINCT employee_id FROM benefits WHERE status = 'active'
       )`
    ).all();

    return createResult({
      data: {
        totalActiveEmployees: totalActive,
        employeesWithBenefits: withBenefits,
        employeesWithoutBenefits: withoutBenefits,
        compliant: withoutBenefits === 0,
        missingBenefits,
      },
      audit: [createAuditEntry(this.name, 'compliance_check', withoutBenefits === 0 ? 'COMPLIANT' : `${withoutBenefits} employees missing benefits`)],
    });
  }
}

export { HRAgent };
