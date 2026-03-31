# Chaos Platform — Production Chaos Engineering for Kubernetes + Solana

A production-grade chaos engineering platform built to the same standards as Netflix Chaos Monkey, but purpose-built for modern Kubernetes + RPC-heavy (Solana) infrastructure.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Layer                             │
│   chaosctl CLI  ·  Next.js Dashboard  ·  CI/CD  ·  Webhooks   │
└─────────────────────────┬───────────────────────────────────────┘
                          │ REST API (JWT-authenticated)
┌─────────────────────────▼───────────────────────────────────────┐
│                    Control Plane (Axum/Fastify)                  │
│  Experiment API  ·  Policy Engine  ·  Kill Switch  ·  Scheduler │
│               PostgreSQL (state) · Redis (kill switch)           │
└─────────────────────────┬───────────────────────────────────────┘
                          │ NATS pub/sub
┌─────────────────────────▼───────────────────────────────────────┐
│                     Chaos Engine (Workers)                       │
│    Pod Kill Runner  ·  Network Chaos  ·  RPC Proxy  ·  Stress   │
│              Health Checker  ·  Metrics Collector               │
└─────────────────────────┬───────────────────────────────────────┘
                          │ Kubernetes API / tc-netem / Redis
┌─────────────────────────▼───────────────────────────────────────┐
│                    Target Infrastructure                          │
│    K8s Pods/Nodes  ·  Solana RPC Nodes  ·  Services  ·  DBs    │
└─────────────────────────────────────────────────────────────────┘
                          ↕ (all layers emit)
┌─────────────────────────────────────────────────────────────────┐
│                       Observability                              │
│         Prometheus  ·  Grafana  ·  OpenTelemetry  ·  Loki      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### 1. Control plane ↔ Engine decoupling via NATS

The control plane never directly executes chaos. It publishes to NATS; workers consume. This means:
- Control plane restarts don't abort running experiments
- Multiple engine workers can run different experiment types in parallel
- The kill switch works even when the control plane is degraded

### 2. Kill switch is Redis-first, not API-first

Workers check Redis directly, bypassing the control plane. A Redis write propagates to workers within ~1 second regardless of API health. The global kill switch is the single most important safety feature — it must work when everything else is broken.

### 3. Policy engine is composable validators

Adding a new safety rule = add one function. The policy system runs all validators in parallel and aggregates violations. Hard blocks prevent execution; warnings are surfaced to the operator but don't block.

### 4. PodDisruptionBudget awareness is mandatory

Every pod-kill action checks PDBs before killing. If a PDB says `disruptionsAllowed: 0`, we skip that pod. This respects the application's own declared availability requirements.

### 5. MTTR is a first-class metric

After every experiment, we poll for system recovery and compute Mean Time To Recovery. This is the most actionable chaos metric — it tells you whether your runbooks, alerts, and auto-healing work.

---

## Monorepo Structure

```
chaos-platform/
├── packages/
│   ├── shared-types/        # Cross-service TypeScript contracts
│   ├── control-plane/       # API server (Fastify + PostgreSQL)
│   │   └── src/
│   │       ├── api/         # REST routes (experiments, kill-switch, metrics)
│   │       ├── engine/      # Kill switch service, K8s client
│   │       ├── policy/      # Policy engine with composable validators
│   │       ├── scheduler/   # Cron-based recurring experiments
│   │       └── observability/
│   ├── chaos-engine/        # Execution workers
│   │   └── src/
│   │       ├── runners/     # Pod kill, network chaos, RPC proxy, stress
│   │       ├── health/      # Pre/post health checking
│   │       └── observability/
│   ├── rpc-proxy/           # Standalone RPC chaos proxy (Solana-ready)
│   ├── cli/                 # chaosctl command-line interface
│   └── dashboard/           # Next.js operational dashboard
├── k8s/
│   ├── rbac/                # ServiceAccount, ClusterRole, CRB
│   ├── daemonsets/          # Network chaos agent (NET_ADMIN)
│   ├── deployments/         # Control plane, chaos engine
│   └── configmaps/
├── experiments/
│   └── examples.yaml        # 7 annotated example experiments
├── docker/
│   ├── init.sql             # PostgreSQL schema
│   ├── prometheus.yml       # Scrape config
│   └── grafana/             # Dashboard provisioning
└── docker-compose.yml       # Full local stack
```

---

## Supported Chaos Types

| Type | Implementation | Notes |
|------|---------------|-------|
| `pod-kill` | Kubernetes DELETE pod API | PDB-aware, random/rolling/burst modes |
| `network-latency` | tc/netem inside pod | DaemonSet agent for host-level control |
| `network-loss` | tc/netem | Configurable packet loss + correlation |
| `network-partition` | iptables + ipset | Block traffic between specific services |
| `rpc-latency` | RPC chaos proxy | Solana JSON-RPC aware |
| `rpc-timeout` | RPC chaos proxy | Hangs connection until client timeout |
| `rpc-corrupt` | RPC chaos proxy | Invalid JSON, truncate, wrong-method |
| `cpu-stress` | stress-ng exec | Configurable load %, workers |
| `memory-exhaust` | stress-ng exec | Configurable bytes, workers |
| `disk-throttle` | stress-ng exec | Sequential I/O stress |
| `node-drain` | K8s node taint | Simulates AZ failure |
| `dependency-kill` | iptables block | DB/Redis/cache outage simulation |

---

## Safety System (Non-Negotiable)

Every experiment goes through this gauntlet before execution:

```
Request → Zod validation → Policy engine → Kill switch check
       → Pre-flight health → PDB check → Blast radius cap
       → Execute with monitoring → Auto-rollback threshold
       → Post-chaos health wait → MTTR calculation
```

**Blast radius maximum**: Configurable globally, default 30%. Cannot be overridden by experiment config.

**Blocked namespaces**: `kube-system`, `kube-public`, `kube-node-lease` are permanently blocked. Additional namespaces configurable at deploy time.

**Auto-rollback**: If error rate or p99 latency exceeds configured thresholds during an experiment, chaos is cleaned up automatically and the status is set to `rolled-back`.

---

## Local Development

```bash
# Start the full stack (Postgres, Redis, NATS, Prometheus, Grafana, all services)
docker compose up -d

# Verify everything is healthy
docker compose ps

# Configure chaosctl
chaosctl login --endpoint http://localhost:3000 --token dev-token

# Run a dry-run to see what would happen
chaosctl dry-run -f experiments/examples.yaml

# Run your first experiment (RPC latency against mock Solana)
chaosctl apply -f experiments/examples.yaml

# Watch it live
chaosctl get experiments

# Open the dashboard
open http://localhost:3002

# Open Grafana (admin/admin)
open http://localhost:3001
```

---

## Kubernetes Deployment

```bash
# Create namespace and secrets
kubectl create namespace chaos-platform
kubectl create secret generic chaos-secrets \
  --from-literal=database-url="postgresql://..." \
  --from-literal=redis-url="redis://..." \
  --from-literal=jwt-secret="$(openssl rand -hex 32)" \
  -n chaos-platform

# Apply RBAC (do this before the deployments — RBAC is a prerequisite)
kubectl apply -f k8s/rbac/

# Deploy the network chaos DaemonSet (requires NET_ADMIN — review before applying)
kubectl apply -f k8s/daemonsets/

# Deploy control plane + engine
kubectl apply -f k8s/deployments/

# Verify
kubectl get pods -n chaos-platform
```

---

## Adding a New Chaos Type

1. Create `packages/chaos-engine/src/runners/my-chaos.ts` implementing:
   - `selectTargets(config): Promise<SelectedTarget[]>`
   - `execute(config, targets, callbacks): Promise<void>`
   - `cleanup(config, targets): Promise<void>`

2. Register in `packages/chaos-engine/src/worker.ts`:
   ```ts
   import { MyChaosRunner } from "./runners/my-chaos";
   const runners = {
     ...existing,
     "my-chaos-type": new MyChaosRunner(),
   };
   ```

3. Add the type to `ExperimentType` union in `packages/shared-types/src/index.ts`

4. Add a YAML example to `experiments/examples.yaml`

That's it. The policy engine, kill switch, health checking, and metrics collection are all automatic.

---

## Chaos Score

The chaos score (0-100) measures how resilient the system was during an experiment:

| Component | Weight | Measures |
|-----------|--------|---------|
| Error rate delta | 40% | Did errors spike? |
| p99 latency delta | 30% | Did latency spike? |
| Recovery speed | 20% | How fast did MTTR complete? |
| Pod availability | 10% | Did pods stay healthy? |

Track scores over time to build a resilience trend. The goal is a steadily rising score as the team fixes the issues chaos reveals.

---

## RBAC Roles

| Role | Permissions |
|------|------------|
| `chaos-viewer` | Read experiments, metrics, audit log |
| `chaos-operator` | Create/pause/kill experiments, namespace kill switch |
| `chaos-admin` | Global kill switch, delete schedules, manage RBAC |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✓ | — | PostgreSQL connection string |
| `REDIS_URL` | ✓ | — | Redis connection string |
| `NATS_URL` | ✓ | nats://localhost:4222 | NATS server |
| `JWT_SECRET` | ✓ | — | JWT signing secret (min 32 chars) |
| `PROMETHEUS_URL` | — | http://prometheus:9090 | For metrics collection |
| `MAX_BLAST_RADIUS_PCT` | — | 30 | Hard cap on blast radius (%) |
| `BLOCKED_NAMESPACES` | — | kube-system,... | Comma-separated blocked namespaces |
| `PORT` | — | 3000 | Control plane HTTP port |
| `TARGET_URL` | — | — | RPC proxy target (rpc-proxy only) |
| `PROXY_ID` | — | default | RPC proxy identifier in Redis |
