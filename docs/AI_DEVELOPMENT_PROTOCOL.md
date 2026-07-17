# Letta 장애대응 — Lucy/Xixi GitHub Protocol

Version: 1.0
Approved: 2026-07-17
Control branch: `lucy/letta-operations`

## Roles

- Tei: Product Owner and high-risk approval owner.
- ChatGPT Lucy: incident architect, primary developer, integrator, reviewer, and final quality gate.
- Letta Lucy: persistent user-facing orchestrator and context owner.
- Xixi: task-scoped Hermes implementation worker.
- GitHub: authoritative task and delivery control plane.
- Codex: not used by default; use only with explicit Tei approval or a clearly justified independent review.

Lucy may inspect and write code directly. Xixi accelerates bounded work and does not replace Lucy's design or acceptance responsibility.

## Runtime boundary

This repository is initially a control plane for Letta incident work. Do not assume its old application code is the source currently deployed on the company server.

Before code modification, every Work Package must name the exact repository, base branch, deployed path, service or container, runtime endpoint, rollback approach, allowed files, forbidden files, and required evidence.

When the runtime source is uncertain, use a read-only Scout task first. Archived chat backends and old Hermes, OpenClaw, or direct-model adapters must not be treated as the current Letta Lucy runtime without evidence.

## Executable Issue

A task may run only when an open Issue contains:

- title prefix `[XIXI]`,
- `Status: READY_FOR_XIXI`,
- an assigned worker,
- an approved base and `xixi/...` target branch,
- a Work Package under `docs/work-packages/`,
- exact scope and acceptance evidence.

Xixi claims the Issue, works only in scope, tests, commits, pushes, opens a Draft PR, and records `XIXI_COMPLETED` or `XIXI_BLOCKED`. Xixi never merges or applies production changes.

## Lucy verdicts

- `PASS — MERGE READY`
- `PASS WITH OPERATIONAL VERIFICATION`
- `CHANGES REQUIRED`
- `REJECTED — OUT OF SCOPE`

## Parallelism

Parallel-safe work includes read-only log analysis, runtime mapping, isolated tests, runbooks, and independent review. Changes to service startup, containers, persistent state, routing, ports, or production application are serialized and require explicit approval before application.

Never use a global `docker compose down`.
