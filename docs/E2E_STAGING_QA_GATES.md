# Staging QA gates: what each one actually verifies

`scripts/ops/staging-browser-smoke.sh` runs `npm run test:e2e:staging`
unconditionally. It does not read any `CHAT_*_QA_REQUIRED` variable. The gating
happens one level below, inside each Playwright spec, as the first statement of
each test:

```ts
test.skip(!enabled('CHAT_MULTIMODAL_QA_REQUIRED'), 'multimodal QA is not enabled');
```

When the variable is absent the test skips itself, Playwright reports success,
and the deployment is green. Nothing in the job output distinguishes "passed"
from "never ran". This document exists so that distinction is not lost again.

`playwright.staging.config.ts` sets `testDir: './e2e-staging'`. The specs under
`e2e/` are for local development and are not part of the staging job.

## Gate to assertion map

| Variable | Spec | Test |
| --- | --- | --- |
| `CHAT_MULTIMODAL_QA_REQUIRED` | `e2e-staging/multimodal.spec.ts` | real Letta and Hermes understand phrases contained only in PDF and image attachments |
| `CHAT_GENERATED_ARTIFACT_QA_REQUIRED` | `e2e-staging/multimodal.spec.ts` | real Hermes returns a generated file that survives reload and byte verification |
| `CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED` | `e2e-staging/letta-full-runtime.spec.ts` | real Letta runtime executes a local tool and reports capabilities |
| `CHAT_EXTERNAL_QA_REQUIRED` | step-level gate in `deploy-staging.yml` | runs `scripts/ops/external-staging-browser-smoke.sh` against the public origin |

## `CHAT_MULTIMODAL_QA_REQUIRED`

Attachment comprehension, proven rather than asserted.

The spec builds a PDF at runtime containing a marker generated at test time,
`ORANGE_CEDAR_PDF_${Date.now()}`, uploads it to `[Letta] Lucy`, and requires the
streamed reply to contain that exact marker. It then draws a PNG on a canvas
containing `BLUE_CACTUS_POSTER_${Date.now()}`, uploads it to the vision agent,
and requires the same.

The marker is freshly generated on every run, so it cannot be present in any
model's weights, cache, or prior conversation. A reply of "I have received your
attachment" fails. Only a model that read the bytes can pass.

Delivery is checked separately from comprehension: the `artifacts.delivery`
event stream must show exactly `['delivering', 'delivered']` with matching
`agentId`, `systemId`, and `artifactIds`.

The vision agent is chosen by `CHAT_HERMES_VISION_AGENT_ID`, defaulting to
`Gemma`. If that agent is not registered, this gate fails on agent resolution
rather than on comprehension. Read the failure message before concluding the
model cannot see.

## `CHAT_GENERATED_ARTIFACT_QA_REQUIRED`

The reverse direction: a file produced by the model reaching the user intact.

Hermes is asked to use `return_artifact` to produce `qa-result.txt` whose whole
content is a fresh marker. The spec then requires, in order:

- an `artifact.created` event naming `qa-result.txt` with mime `text/plain`
- `GET /api/artifacts/{id}/download` returning 200 with a body equal to the
  marker byte for byte
- the file card visible in the assistant message in a real browser
- the file card still visible after `page.reload()`

The reload step is the substantive one. It separates an artifact that exists in
the response stream from an artifact that was actually persisted.

This gate depends on `return_artifact` being registered on the Hermes agent. If
it is not, the failure will appear as a missing `artifact.created` event.

## `CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED` (deferred)

Whether the agent ran its tools, as opposed to describing what running them
would produce.

The spec issues an HMAC challenge keyed on `CHAT_V2_TOOL_PROBE_SECRET`, a value
deliberately absent from the prompt. The answer is unreachable by reasoning, so
only genuine `Bash` execution can produce it. It then requires
`tool.running:hmac_challenge_probe` to precede
`tool.completed:hmac_challenge_probe`, and parses these run statuses:

- `runtime.model:` present, not `null`, longer than two characters
- `runtime.permission:` present, not `unknown`
- `runtime.capabilities:tools=N;skill_sources=N;mcp=N;commands=N;memfs=true|false`
  matching exactly, with `tools > 0`, `skill_sources > 0`, `memfs` true
- `runtime.mcp_advertised:true`
- `runtime.slash_commands_advertised:true`

The reply must contain the model name and the literal
`[verified-tool-hmac-redacted]`, and must not contain the probe secret or any
64-character hex string. It must also not match
`/do not know|don't know|모르|알 수 없/`, closing the escape of a polite refusal
in either language.

This gate is deferred, and is pinned to the string literal `'false'` in the
workflow rather than read from a variable.

The reason is not that the behaviour is unwanted. It is that this spec was
written against the legacy Letta CLI bridge, where the runtime emitted these
statuses directly. The lane now runs through the private OpenClaw Gateway, and
it has not been established that OpenClaw emits `runtime.model:`,
`runtime.permission:`, `runtime.capabilities:`, `runtime.mcp_advertised:`, or
`runtime.slash_commands_advertised:`, nor that it exposes a
`hmac_challenge_probe` tool.

Enabling this gate before answering that question would produce a failure that
says nothing about whether tools actually execute. Establish what the gateway
emits first; then either enable the gate or rewrite its assertions against the
statuses OpenClaw does emit.

## `CHAT_EXTERNAL_QA_REQUIRED` (deferred)

The same surface reached through the public Cloudflare Access hostname instead
of `127.0.0.1:14174`, exercising the Access service-token path and the tunnel.

Deferred until the two enabled gates pass on loopback. Running it earlier
conflates application failures with ingress failures.

## Interpreting a failure

The job uploads `test-results-staging-browser` and `playwright-staging-report`
as part of the `chat-v2-staging-deployment-{run_id}` artifact, retained 30 days.
The HTML report names the failing assertion and the received value, which is
usually sufficient to distinguish these cases:

- agent not found — a configuration problem, fix the agent id variable
- tool not registered — a capability problem on the agent side
- marker absent from reply — the substantive failure this gate exists to catch
- authentication throw before any test runs — `CHAT_STAGING_EMAIL` or the
  `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` pair is incomplete; the helper
  fails closed when only one of the pair is present

## Relationship to acceptance

`docs/OPENCLAW_LETTA_CHAT_ACCEPTANCE.md` records 4 of 11 items met. Several of
the unmet items are covered by the specs above, which means they are unverified
rather than unimplemented. They remain unmet until a run produces evidence.
Enabling a gate is not evidence; a passing run is.
