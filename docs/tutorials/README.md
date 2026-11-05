# Tutorials: build it yourself

Each tutorial walks you through adding a real feature to Spine, test-first, explaining
every decision. Do them in order; each takes about 30–60 minutes.

1. [Write a scoring rule](01-write-a-scoring-rule.md): the predicate language, rule
   weights, explanations and property tests.
2. [Write an enricher](02-write-an-enricher.md): the `Enricher` port, fixtures, and
   wrapping a provider in timeout/retry/circuit breaker/bulkhead.
3. [Write a playbook step type](03-write-a-playbook-step.md): DSL schema, load-time
   validation, the handler port, idempotency and compensation.
4. [Triage with an AI analyst over MCP](04-triage-with-an-ai-analyst.md): MCP tools and
   annotations, prompt injection through alert data, server-side guardrails, and adding a tool
   test-first.
