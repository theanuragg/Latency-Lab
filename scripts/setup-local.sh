#!/usr/bin/env bash
# scripts/setup-local.sh
# One-shot local development setup script.
# Run this once after cloning. After that, use `npm run docker:up`.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== Chaos Platform — Local Setup ===${NC}"

# Check prerequisites
for cmd in docker node npm; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is required but not installed."
    exit 1
  fi
done

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "ERROR: Node.js 20+ required (got $(node -v))"
  exit 1
fi

echo -e "${GREEN}✓ Prerequisites OK${NC}"

# Install dependencies
echo -e "${YELLOW}Installing dependencies...${NC}"
npm install

# Copy .env if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo -e "${GREEN}✓ Created .env from .env.example${NC}"
fi

# Start infrastructure
echo -e "${YELLOW}Starting Docker services...${NC}"
docker compose up -d postgres redis nats prometheus grafana loki mock-solana

# Wait for postgres
echo -e "${YELLOW}Waiting for PostgreSQL...${NC}"
until docker compose exec postgres pg_isready -U chaos -q; do
  sleep 1
done
echo -e "${GREEN}✓ PostgreSQL ready${NC}"

# Run migrations
echo -e "${YELLOW}Running database migrations...${NC}"
cd packages/control-plane
DATABASE_URL="postgresql://chaos:chaos-dev-password@localhost:5432/chaosplatform" \
  npx knex migrate:latest --knexfile knexfile.ts
cd ../..
echo -e "${GREEN}✓ Migrations complete${NC}"

# Start application services
echo -e "${YELLOW}Starting application services...${NC}"
docker compose up -d control-plane chaos-engine rpc-proxy

# Wait for control plane
echo -e "${YELLOW}Waiting for control plane...${NC}"
for i in {1..30}; do
  if curl -sf http://localhost:3000/api/v1/health > /dev/null 2>&1; then
    break
  fi
  sleep 2
done
echo -e "${GREEN}✓ Control plane ready${NC}"

# Configure chaosctl
echo -e "${YELLOW}Configuring chaosctl...${NC}"
mkdir -p ~/.chaosctl

# Get a dev token
TOKEN=$(curl -sf "http://localhost:3000/api/v1/dev-token?role=chaos-admin" | grep -o '"token":"[^"]*"' | cut -d'"' -f4 || echo "dev-token")

cat > ~/.chaosctl/config.yaml << EOF
endpoint: http://localhost:3000
token: ${TOKEN}
defaultNamespace: default
EOF
echo -e "${GREEN}✓ chaosctl configured${NC}"

echo ""
echo -e "${GREEN}=== Setup Complete ===${NC}"
echo ""
echo "Services:"
echo "  Control plane:  http://localhost:3000"
echo "  Dashboard:      http://localhost:3002  (start with: npm run dev -w packages/dashboard)"
echo "  Grafana:        http://localhost:3001  (admin/admin)"
echo "  Prometheus:     http://localhost:9091"
echo "  RPC Proxy:      http://localhost:9090  (forwards to mock Solana)"
echo ""
echo "Quick start:"
echo "  chaosctl get experiments"
echo "  chaosctl dry-run -f experiments/examples.yaml"
echo "  chaosctl apply -f experiments/examples.yaml"
echo ""
echo "Logs:"
echo "  docker compose logs -f control-plane chaos-engine"
