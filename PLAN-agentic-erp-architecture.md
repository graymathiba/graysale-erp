# Agentic ERP Architecture Plan

## Context

The user wants to transform the existing network speed test infrastructure into an **agentic, multi-role ERP system** where different "personas" (agents) own their domains and communicate through an orchestrator — similar to a corporate hierarchy with department heads reporting to a CEO.

This document outlines the architecture for implementing specialized agents (Finance, HR, Supply Chain, etc.) on top of the existing Go/Gin + Terraform/Helm stack.

---

## Current State

| Layer | Technology |
|-------|-----------|
| API Server | Go 1.26 + Gin (`cmd/root.go`, `internal/api/`) |
| HTTP Tests | HTTP API + WebSocket (`internal/api/http_test.go`) |
| Infra | Terraform modules (`terraform/modules/`) |
| K8s | Helm chart (`helm/azure-network-speedtest/`) |
| Observability | OpenTelemetry Collector (`otel-otel-collector/`) |

The current codebase is a network speed-test service. The ERP agents will be a **new subsystem** within this Go module, coexisting alongside the existing speed-test handlers.

---

## Target Architecture

```
cmd/
  server.go              # Existing — starts Gin + agents
internal/
  agents/
    orchestrator.go      # Central coordinator (CEO role)
    registry.go          # Agent registration + discovery
    agent.go             # Agent interface definition
    finance/
      agent.go           # FIN_AGENT — GL, AP, AR, tax
    hr/
      agent.go           # HR_AGENT — payroll, benefits, compliance
    supply_chain/
      agent.go           # SCM_AGENT — inventory, warehouse, logistics
    procurement/
      agent.go           # PROC_AGENT — POs, vendor mgmt, 3-way match
    sales/
      agent.go           # SALES_AGENT — leads, quotes, order-to-cash
    common/
      message.go         # Typed message envelope (Intent, Result, Error)
      risk.go            # Risk scoring engine
      saga.go            # Saga pattern coordinator
```

---

## Implementation Plan

### Phase 1: Agent Framework (`internal/agents/`)

**Step 1 — Define the `Agent` interface**

```go
// internal/agents/agent.go
type Agent interface {
    Name() string
    Role() string
    Handle(ctx context.Context, msg Message) (Result, error)
    Capabilities() []string
}
```

Every agent (Finance, HR, SCM, etc.) implements this interface.

**Step 2 — Define `Message` and `Result` types**

```go
// internal/agents/common/message.go
type Message struct {
    ID        string
    Type      MessageType   // QUERY, COMMAND, EVENT
    From      string        // sender agent name
    To        string        // target agent name
    Domain    string        // e.g. "finance.hr", "scm.inventory"
    Payload   []byte        // JSON-encoded domain payload
    Metadata  map[string]string
}

type Result struct {
    Status   ResultStatus  // SUCCESS, FAILURE, PENDING_APPROVAL
    Data     []byte
    Risk     RiskScore
    AuditLog []AuditEntry
}
```

**Step 3 — Implement the Orchestrator**

```go
// internal/agents/orchestrator.go
type Orchestrator struct {
    agents map[string]Agent
    risk   *RiskEngine
    saga   *SagaRunner
}
```

- Routes messages to correct agent by `Domain` prefix
- Enforces risk gates before execution
- Runs sagas for multi-step transactions

**Step 4 — Implement the Risk Engine**

```go
// internal/agents/common/risk.go
type RiskEngine struct {
    approvalThreshold float64  // default 0.75
}

func (r *RiskEngine) Score(financialImpact, sensitivity, confidence float64) RiskScore {
    // R = (0.5 * C_financial) + (0.3 * P_sensitivity) + (0.2 * (1.0 - Confidence))
    score := 0.5*financialImpact + 0.3*sensitivity + 0.2*(1.0-confidence)
    return RiskScore{
        Value:   score,
        RequiresApproval: score >= 0.75,
    }
}
```

**Step 5 — Implement the Saga Runner**

```go
// internal/agents/common/saga.go
type SagaStep struct {
    Execute   func(ctx context.Context) error
    Compensate func(ctx context.Context) error
}

type SagaRunner struct{}

func (s *SagaRunner) Run(ctx context.Context, steps []SagaStep) error {
    executed := make([]int, 0)
    for i, step := range steps {
        if err := step.Execute(ctx); err != nil {
            // Compensate in reverse
            for j := len(executed) - 1; j >= 0; j-- {
                steps[executed[j]].Compensate(ctx)
            }
            return fmt.Errorf("saga rolled back at step %d: %w", i, err)
            }
        executed = append(executed, i)
    }
    return nil
}
```

**Step 6 — Build the Agent Registry**

```go
// internal/agents/registry.go
type Registry struct {
    mu      sync.RWMutex
    agents  map[string]Agent
    domains map[string]string  // domain prefix -> agent name
}

func (r *Registry) Register(a Agent, domains []string) { ... }
func (r *Registry) Lookup(domain string) (Agent, bool) { ... }
```

---

### Phase 2: Domain Agents

Each agent is a separate file implementing the `Agent` interface. They contain **business logic only** — no HTTP, no DB calls directly (those are injected via dependency interfaces).

| Agent | File | Key Capabilities |
|-------|------|-----------------|
| `FIN_AGENT` | `internal/agents/finance/agent.go` | `ledger.get_balance`, `journal.post`, `ar.invoice`, `ap.pay` |
| `HR_AGENT` | `internal/agents/hr/agent.go` | `employee.get`, `payroll.calculate`, `benefits.enroll` |
| `SCM_AGENT` | `internal/agents/supply_chain/agent.go` | `inventory.check`, `warehouse.transfer`, `logistics.track` |
| `PROC_AGENT` | `internal/agents/procurement/agent.go` | `po.create`, `vendor.evaluate`, `invoice.match_3way` |
| `SALES_AGENT` | `internal/agents/sales/agent.go` | `lead.score`, `quote.generate`, `order.commit` |

---

### Phase 3: API Endpoints

Add new Gin routes to expose agent capabilities:

```
POST /api/v1/agents/message     — Send message to an agent via orchestrator
GET  /api/v1/agents             — List registered agents
GET  /api/v1/agents/:id/status  — Agent health/status
POST /api/v1/agents/flow        — Execute a multi-step flow (saga)
```

These will be registered in `internal/api/router.go` alongside existing speed-test routes.

---

### Phase 4: Verification

1. **Unit tests**: Each agent implements a `TestHandle` function verifying it processes known intents correctly
2. **Integration test**: Send a message through the orchestrator, verify saga execution + compensation
3. **Risk gate test**: Verify high-risk actions return `PENDING_APPROVAL` status
4. **Run existing tests** to ensure no regressions: `go test ./...`

---

## File Change Summary

| File | Action |
|------|--------|
| `internal/agents/agent.go` | **Create** — Agent interface |
| `internal/agents/common/message.go` | **Create** — Message/Result types |
| `internal/agents/common/risk.go` | **Create** — Risk scoring engine |
| `internal/agents/common/saga.go` | **Create** — Saga pattern runner |
| `internal/agents/orchestrator.go` | **Create** — Central coordinator |
| `internal/agents/registry.go` | **Create** — Agent registry |
| `internal/agents/finance/agent.go` | **Create** — Finance agent |
| `internal/agents/hr/agent.go` | **Create** — HR agent |
| `internal/agents/supply_chain/agent.go` | **Create** — Supply chain agent |
| `internal/agents/procurement/agent.go` | **Create** — Procurement agent |
| `internal/agents/sales/agent.go` | **Create** — Sales agent |
| `internal/api/router.go` | **Modify** — Add agent endpoints |

Total: **11 new files, 1 modified file**

---

## Decisions & Assumptions

- Agents are **in-process Go structs**, not separate microservices (keep it simple for first iteration)
- The existing `cmd/root.go` server boots the orchestrator on startup
- Domain logic uses interface-based dependencies (repository interfaces) so real DB implementations can be added later
- Risk scoring uses the formula from the ERP spec as-is
- Saga compensation is best-effort with audit logging (no 2PC)

---

## Expected Outcome

After implementation:
- `go build ./...` succeeds
- `go test ./...` passes (unit tests for each agent + orchestrator)
- An orchestrator instance can route messages to Finance, HR, SCM, Procurement, and Sales agents
- Multi-step flows execute with saga rollback on failure
- High-risk actions (e.g., payroll run > $100k) trigger `PENDING_APPROVAL` status
- Existing speed-test functionality is unaffected
