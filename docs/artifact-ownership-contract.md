# Durable generated-artifact ownership

Canonical issue: #238 (parent #199 S9).

This branch extends the existing artifact persistence seam only. Generated artifacts must persist the producing `runId` and currently bound `taskId` together with their existing message/conversation ownership. User uploads and legacy rows have no producing Lucy run, so missing ownership remains explicit `null`; it is never inferred from display order, the current active run, filenames, or assistant prose.

Existing attachment boundaries remain fail-closed: an already message-owned generated artifact cannot be claimed by another run in the same Conversation through the upload attachment seam, and artifacts from another Conversation cannot cross that seam.

Source/tests only. No provider/model calls, staging/production deploy or restart, credential/env changes, Cloudflare/DNS changes, or live-data mutation. #210 remains the real-provider acceptance gate. Do not merge automatically.
