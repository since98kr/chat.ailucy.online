# Work order: expose one Hermes model per profile

Owner: Hermes Lucy (executes on `agentlucy`)
Requested by: Lucy (GitHub side)
Branch: `lucy/hermes-multi-profile-api`

## Why

`deploy-staging` run `31555510584` (job `93986996050`) failed on two E2E
tests. The first one is fully diagnosed:

`e2e-staging/multimodal.spec.ts:117` passes its Letta leg and fails on the
Hermes leg with

```
Array [
  "delivering",
-  "delivered",
+  "failed",
]
```

The test opens the Hermes conversation with
`process.env.CHAT_HERMES_VISION_AGENT_ID?.trim() || 'Gemma'`, and
`CHAT_HERMES_VISION_AGENT_ID` was empty in that run, so the agent id was
`Gemma`. The job environment also showed

```
HERMES_MODEL_MAP_JSON: {"[Hermes] Lucy":"hermes-agent"}
```

`server/adapters/http.ts` throws whenever the selected agent has no entry in
the model map, so the Gemma leg cannot succeed under the current
configuration.

Adding `"Gemma"` to the model map is not enough by itself. Hermes runs one
gateway per profile and each gateway exposes exactly one model, whereas
Chat V2 assumes a single base URL serving many models and branches on the
`model` field. Today only the default profile has the `API_SERVER_*`
variable group, so `gemma`, `lynn` and `xixi` never open an
OpenAI-compatible endpoint at all.

Step 1 below creates the missing second endpoint. Routing comes after it is
proven.

## Scope of this order

Only the `gemma` profile. Do not touch `lynn` or `xixi` yet: their DeepSeek
credentials are believed to be unset, which would confuse the result. Do not
touch the `default` profile at all.

## Step 1 - enable the API server on the gemma profile

```bash
cd ~/chat.ailucy.online 2>/dev/null || cd ~   # any checkout of this repo
git fetch origin
git checkout lucy/hermes-multi-profile-api
git pull --ff-only

bash ops/hermes/enable-profile-api.sh gemma 8643
```

The script backs up `~/.hermes/profiles/gemma/.env` before writing, copies
the API key from the default profile without printing it, and is safe to run
twice.

Expected output ends with the five key names:

```
API_SERVER_ENABLED
API_SERVER_HOST
API_SERVER_KEY
API_SERVER_MODEL_NAME
API_SERVER_PORT
```

## Step 2 - find the correct way to start a per-profile gateway

`hermes gateway` manages messaging platforms and exposes no port or profile
selection flags, so it is probably not the right entry point. Capture the
help output for these and report it verbatim:

```bash
hermes profile --help
hermes serve --help
hermes proxy --help
```

Do not start anything yet if none of them obviously accepts a profile.
Report the help text and stop; Lucy will pick the command.

## Step 3 - start it and verify

Once the correct command is known, start the `gemma` profile and verify:

```bash
set -a; . ~/.hermes/.env; set +a
curl -s -w '\nHTTP %{http_code}\n' \
  http://172.17.0.1:8643/v1/models \
  -H "Authorization: Bearer $API_SERVER_KEY" | head -c 1500; echo
```

Pass criteria: HTTP 200 and exactly one entry whose `id` is `gemma`.

Then confirm the default profile is unharmed:

```bash
curl -s -w '\nHTTP %{http_code}\n' \
  http://172.17.0.1:8642/v1/models \
  -H "Authorization: Bearer $API_SERVER_KEY" | head -c 1500; echo
```

Pass criteria: still HTTP 200 with `hermes-agent`.

Also confirm the model actually answers, not just that it is listed:

```bash
curl -s -w '\nHTTP %{http_code}\n' \
  http://172.17.0.1:8643/v1/chat/completions \
  -H "Authorization: Bearer $API_SERVER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemma","messages":[{"role":"user","content":"reply with the single word READY"}]}' \
  | head -c 1500; echo
```

## Reporting

Report, verbatim and untruncated:

1. the tail of the `enable-profile-api.sh` output,
2. the three `--help` outputs from step 2,
3. the exact command used to start the gateway,
4. all three curl results from step 3 including the `HTTP <code>` line.

Never paste the value of `API_SERVER_KEY` or any other secret.

Do not grep or filter curl output before reporting it. A previous
misdiagnosis in this project was caused by judging a response from filtered
output.

## Rollback

```bash
ls -1 ~/.hermes/profiles/gemma/.env.bak.*
cp ~/.hermes/profiles/gemma/.env.bak.<timestamp> ~/.hermes/profiles/gemma/.env
```

Then stop whatever was started in step 3. The default profile on 8642 is
never modified by this order, so staging keeps working throughout.

## Not in scope

- Changing any Chat V2 source file.
- Changing GitHub Actions variables or secrets.
- Restarting or redeploying the staging container.
- Enabling `lynn` or `xixi`.
