# READ FIRST — Chat ↔ OpenClaw 연동 경계

## 한 줄 결론

**`chat.ailucy.online`은 OpenClaw endpoint만 연동한다.**

Chat이 Letta를 직접 호출하거나 Letta runtime을 직접 관리하지 않는다.

```text
chat.ailucy.online
        |
        | HTTPS / OpenAI-compatible API
        v
private OpenClaw Gateway
        |
        v
OpenClaw main agent
        |
        v
Letta Lucy
```

## Chat이 알아야 하는 것

Chat의 책임은 아래까지만이다.

- private OpenClaw Gateway endpoint
- Gateway authentication
- explicit OpenClaw agent target (`openclaw/main` 또는 현재 실제 target)
- Chat Conversation → OpenClaw session mapping
- request/stream/attachment/generated-artifact contract
- timeout / retry / cancellation / duplicate protection
- backend error fail-closed 처리
- browser에 secret, raw tool argument, private path를 노출하지 않는 것

## Chat이 알 필요 없는 것

아래는 OpenClaw/Letta runtime 내부 책임이다.

- OpenClaw 안에서 Letta Lucy가 어떻게 실행되는지
- Letta model/runtime process 직접 제어
- Letta tool/skill/MCP 직접 연결
- Letta CLI bridge 직접 rollout
- Letta memory/runtime lifecycle 직접 관리
- OpenClaw worker/task/scheduler/approval/audit 내부 구현

Chat 코드가 이 내부 구조에 직접 의존하면 안 된다.

## 절대 다시 만들지 말 것

새 조력자는 아래 구조를 다시 만들지 않는다.

```text
Chat -> direct Letta CLI bridge
Chat -> direct Letta local tool execution
Chat -> Letta service/process control
```

이것은 현재 목표 아키텍처가 아니다.

## 정확한 책임 분리

```text
Chat
- UI / Conversation / auth
- OpenClaw API client
- session key 전달
- attachment input
- response streaming
- generated artifact 수신
- retry/cancel/dedup

OpenClaw
- Chat이 호출하는 유일한 AI execution endpoint
- agent routing
- workers / tools / tasks
- scheduler / approvals / audit
- Letta Lucy 연결

Letta Lucy
- OpenClaw 내부에서 사용되는 Lucy cognition / identity / memory 계층
```

중요한 점은 **Letta Lucy의 정체성과 memory가 유지된다는 것**이지, Chat이 Letta에 직접 연결되어야 한다는 뜻이 아니다.

## staging에서 증명할 것

Chat 관점의 최종 staging 검증은 단순해야 한다.

1. Chat container에서 private OpenClaw Gateway에 도달 가능하다.
2. 인증된 OpenClaw endpoint가 응답한다.
3. explicit target이 실제 Lucy agent로 resolve된다.
4. 같은 Chat Conversation이 같은 OpenClaw session으로 이어진다.
5. 두 번째 turn에서 continuity가 유지된다.
6. attachment가 OpenClaw endpoint를 통해 정상 전달된다.
7. generated artifact가 Chat artifact contract로 돌아온다.
8. retry/cancel 상황에서 동일 user turn이 중복 전송되지 않는다.
9. OpenClaw 내부 tool/task 실행이 필요하면 OpenClaw가 처리한다.
10. Chat에는 sanitized result/status만 돌아온다.

## configuration mental model

Chat staging에서 핵심은 사실상 다음이다.

```text
OPENCLAW_GATEWAY_BASE_URL
OPENCLAW_GATEWAY_TOKEN
LETTA_OPENCLAW_AGENT_TARGET
LETTA_OPENCLAW_SESSION_PREFIX
```

이름에 `LETTA_`가 남아 있는 것은 Chat 내부 adapter naming/history 때문이다.
**네트워크 경계상 실제 연결 대상은 OpenClaw Gateway다.**

## 새 조력자에게 주는 규칙

문제가 생기면 먼저 다음 질문부터 한다.

> "Chat → OpenClaw API contract 문제인가, 아니면 OpenClaw 내부 runtime 문제인가?"

- 전자면 `chat.ailucy.online`에서 수정한다.
- 후자면 `lucy-openclaw-control` / OpenClaw runtime 쪽에서 수정한다.
- Chat에서 OpenClaw 내부 Letta 구현을 우회하거나 직접 제어하는 식으로 해결하지 않는다.

이 문서는 Chat finalization 작업에서 **아키텍처 경계에 대한 우선 해석 문서**다. 긴 인수인계 문서와 표현이 충돌하면 이 파일의 경계를 우선한다.
