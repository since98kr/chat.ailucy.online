# Restricted staging SSH bootstrap

The Chat V2 staging runner uses the `chat-runner` service account. The already-working Letta tunnel uses a separate trusted local account. Because their SSH trust stores are intentionally isolated, staging bridge rollout requires a one-time restricted deployment identity.

## Confirmed failure

Staging run `29981563916` reported:

```json
{
  "category": "ssh-host-key-verification",
  "runner_user": "chat-runner",
  "remote_user": "since98kr",
  "identity_source": "runner-default",
  "known_hosts_source": "runner-default"
}
```

This is not a Chat V2, Letta, model, tool, MCP, or authentication failure. The staging runner refused an untrusted SSH host key before remote rollout began.

## One-time bootstrap

Log in to `agentlucy` as the same non-root user that owns the active `letta-bridge-tunnel.service`, enter the checked-out repository, and run:

```bash
bash ops/letta-bridge/bootstrap-staging-ssh-access.sh
```

Do not run it as root or as `chat-runner`.

The script fails unless all of the following are true:

- `gh` is authenticated for `since98kr/chat.ailucy.online`;
- `letta-bridge-tunnel.service` is active;
- the current user is the service's configured user;
- the tunnel enforces `StrictHostKeyChecking=yes`;
- the tunnel targets the configured host, port, and remote user;
- the current user's existing `known_hosts` contains a trusted `[host]:port` entry;
- the current trusted SSH identity can connect using that exact entry;
- the remote bridge environment, installed bridge, and rollout helper are usable.

## What it installs

The bootstrap generates a temporary Ed25519 key and installs only its public key remotely. The remote `authorized_keys` entry uses:

```text
restrict,command=".../authorized-rollout-gate.sh"
```

The forced-command gate permits only:

```text
letta-preflight-v1
letta-rollout-v1
```

The rollout command accepts one tar payload containing exactly one regular file named `letta-cli-bridge.mjs`. Extra files, alternate paths, absolute paths, traversal, symlinks, arbitrary commands, interactive shells, forwarding, and PTY use are rejected.

## GitHub configuration

The bootstrap writes these values directly to the GitHub `staging` Environment without printing them:

- secret `LETTA_SSH_PRIVATE_KEY`;
- secret `LETTA_SSH_KNOWN_HOSTS`;
- variable `LETTA_SSH_RESTRICTED_MODE=true`.

The private key exists only in the bootstrap's temporary directory before being uploaded and is removed at exit. The trusted known_hosts entry comes from the existing strict tunnel user's trust store. The script does not use `ssh-keyscan` or trust-on-first-use.

After enrollment, it dispatches `deploy-staging.yml` for exact `main`.

## Rotation

Running the bootstrap again replaces the prior `chat-staging-letta-deploy` authorized key entry and updates the two GitHub Environment secrets. Old temporary private material is not retained.

## Revocation

To revoke staging bridge deployment access:

1. Delete GitHub staging secrets `LETTA_SSH_PRIVATE_KEY` and `LETTA_SSH_KNOWN_HOSTS`.
2. Remove the `chat-staging-letta-deploy` line from the remote user's `~/.ssh/authorized_keys` through the existing trusted SSH path.
3. Leave the active application bridge and tunnel untouched.

Revocation affects only automated bridge rollout. It does not stop Chat V2, modify production, alter Letta data, or change Cloudflare.
