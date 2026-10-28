# Developer entry points. `make help` lists targets.
SHELL := /bin/bash
COMPOSE := docker compose -f infra/docker-compose.yml --env-file .env

.PHONY: help install check test test-integration e2e build up down logs demo load-test openapi clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.env:
	cp .env.example .env

install: .env ## Install dependencies
	pnpm install --frozen-lockfile

check: ## Lint, architecture rules, typecheck, unit tests, docs checks
	pnpm lint && pnpm lint:arch && pnpm typecheck && pnpm test && pnpm docs:check

test: ## Unit + property tests
	pnpm test

test-integration: ## Integration tests (Docker or TEST_DATABASE_URL/TEST_REDIS_URL)
	pnpm test:integration

e2e: ## End-to-end tests against a running stack (make up first)
	pnpm test:e2e

build: ## Build all packages and apps
	pnpm build

openapi: ## Regenerate docs/architecture/openapi.json
	pnpm openapi:generate

infra/tls/server.crt:
	./scripts/dev-certs.sh

up: .env infra/tls/server.crt ## Start the full stack (API, worker, console, Postgres, Redis, Prometheus, Grafana)
	$(COMPOSE) up -d --build

down: ## Stop the stack
	$(COMPOSE) down

logs: ## Follow logs
	$(COMPOSE) logs -f api worker

demo: up ## One-command demo: start the stack, seed synthetic incidents, play the story
	./scripts/demo.sh

load-test: ## k6 load test against the running stack
	./scripts/load-test.sh

clean: ## Remove build output
	rm -rf apps/*/dist packages/*/dist coverage apps/*/coverage packages/*/coverage
