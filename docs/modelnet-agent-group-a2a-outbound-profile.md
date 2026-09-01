# ModelNet Agent Group A2A Outbound Profile v1

> Status: locked for isolated Dev validation on 2026-09-01

## Protocol baseline

ModelNet locks the wire contract to A2A `1.0` (`A2A-Version: 1.0`). The implementation follows the current 1.0 REST/JSON contract and includes the fixes published in the official `v1.0.1` patch release; a database binding cannot select an arbitrary protocol version or transport profile.

The supported profile is deliberately narrow:

- HTTP+JSON with `Content-Type: application/a2a+json`;
- `POST message:stream` over SSE when the binding selects `stream`;
- automatic fallback to `POST message:send` plus `GET tasks/{id}` only when streaming is explicitly unsupported (`404`, `405`, or `501`);
- `POST tasks/{id}:cancel` for best-effort remote cancellation;
- `input-required` continuation by sending a new message with the same `taskId` and `contextId`;
- no push notification callbacks, Agent Card discovery, file URL download, extension negotiation, or OAuth discovery in v1.

Normative references:

- <https://github.com/a2aproject/A2A/blob/main/docs/specification.md>
- <https://a2a-protocol.org/latest/definitions/>
- <https://a2a-protocol.org/latest/topics/streaming-and-async/>

## Binding and trust boundary

One local Agent identity can have at most one `external_agent_bindings` row. The binding stores only protocol metadata and an opaque `credentialRef`; it never stores a bearer credential value.

The deployment remains the authority:

- `A2A_TRUSTED_ORIGINS` is an exact, comma-separated Origin allowlist;
- private address access additionally requires the Origin in `A2A_TRUSTED_PRIVATE_ORIGINS`;
- HTTP additionally requires both `A2A_DEPLOYMENT_ENV=development` and `A2A_ALLOW_INSECURE_HTTP=1`;
- production bindings therefore use HTTPS;
- URL credentials, query parameters, fragments, redirects, and cross-Origin path resolution are rejected;
- v1 bearer references are restricted to `env:A2A_*`; the resolved value is used only to build the outbound Authorization header;
- body size and request duration are bounded by deployment ceilings; a database trust snapshot can narrow but never widen them.

The server exposes owner/workspace-authorized binding get/upsert/delete procedures. Endpoint and credential reference validation happens before the row is written.

## Shared lifecycle mapping

An external node is selected only by an immutable node policy with `runtimeKind=external`. Pipeline Dispatcher then:

1. prepares the ordinary group message bridge;
2. creates a deterministic A2A `AgentOperation` and persists its dispatch preparation;
3. commits the fenced external Attempt using the same Run and Node rows as local members;
4. publishes the queue message with a deterministic provider deduplication key;
5. records the queue acknowledgement without replacing sibling operation metadata.

The recovery sweep republishes a prepared external operation whose queue acknowledgement is absent. It never creates another Attempt for the same fenced claim.

Remote states map as follows:

| A2A state                      | AgentOperation    | Attempt / Run behavior                                                                               |
| ------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------- |
| completed                      | done              | ordinary completed Attempt; supervisor barrier advances                                              |
| failed / rejected              | error             | failed Attempt; dependency failure policy applies                                                    |
| canceled                       | interrupted       | cancelled Attempt                                                                                    |
| input-required / auth-required | waiting_for_human | ordinary Intervention gate; continuation uses the same operation, Attempt, `taskId`, and `contextId` |

Remote `taskId` and `contextId` are persisted in `external_execution_ref`. A2A Artifacts become private `a2a_artifact` Work/WorkVersion records rooted at the external operation. Inline text/JSON is bounded; remote file references are never fetched, and persisted URLs have credentials and query strings removed.

Run cancellation and timeout first attempt `tasks/{id}:cancel`, then make the local PostgreSQL lifecycle authoritative even if the remote endpoint is unavailable.

## Isolated Dev acceptance endpoint

`docker-compose.dev.yml` runs `a2a-dev-agent` on the private Dev network. The app explicitly trusts only `http://a2a-dev-agent:3400`; these HTTP/private-network exceptions are not present in production configuration. Unit tests provide controlled transport mocks, while the container provides a real HTTP/SSE endpoint for migration, queue, Dispatcher, Artifact, cancellation, recovery, and Intervention smoke tests.

The Dev endpoint supports two bounded scenarios:

- ordinary instruction: terminal completion plus one text Artifact;
- instruction containing `MODELNET_A2A_INPUT_REQUIRED`: `input-required`, followed by completion when the same task is continued.

No production deployment or third-party endpoint is authorized by this profile.
