// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalAgentBindingItem } from '@/database/schemas';

import { A2AHttpJsonAdapter } from './A2AHttpJsonAdapter';

const binding = (overrides: Partial<ExternalAgentBindingItem> = {}): ExternalAgentBindingItem => ({
  agentId: 'agent-external',
  accessedAt: new Date(),
  authScheme: 'none',
  createdAt: new Date(),
  credentialRef: null,
  enabled: true,
  endpointUrl: 'https://trusted.example/a2a/',
  id: '00000000-0000-4000-8000-000000000001',
  interactionMode: 'stream',
  protocolVersion: '1.0',
  transportProfile: 'http-json',
  trustPolicy: {
    allowedOrigin: 'https://trusted.example',
    allowInsecureHttp: false,
    allowPrivateNetwork: false,
    maxResponseBytes: 1024 * 1024,
    requestTimeoutMs: 30_000,
  },
  updatedAt: new Date(),
  userId: 'user-1',
  workspaceId: null,
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/a2a+json' },
    status,
  });

const task = (state: string, overrides: Record<string, unknown> = {}) => ({
  contextId: 'context-1',
  id: 'task-1',
  status: { state },
  ...overrides,
});

describe('A2AHttpJsonAdapter', () => {
  afterEach(() => vi.unstubAllEnvs());

  const trust = () => vi.stubEnv('A2A_TRUSTED_ORIGINS', 'https://trusted.example');

  it('maps a streamed task and persists redacted artifact content', async () => {
    trust();
    const sse = [
      {
        task: task('TASK_STATE_WORKING', {
          artifacts: [
            {
              artifactId: 'artifact-1',
              parts: [{ url: 'https://files.example/result.txt?signature=top-secret' }],
            },
          ],
        }),
      },
      {
        statusUpdate: {
          contextId: 'context-1',
          status: {
            message: { messageId: 'm2', parts: [{ text: 'done' }], role: 'ROLE_AGENT' },
            state: 'TASK_STATE_COMPLETED',
          },
          taskId: 'task-1',
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join('');
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(sse, { headers: { 'content-type': 'text/event-stream' } }));

    const result = await new A2AHttpJsonAdapter(binding(), fetchImpl as never).execute({
      instruction: 'perform the task',
      messageId: 'message-1',
    });

    expect(result).toMatchObject({
      contextId: 'context-1',
      outcome: 'completed',
      taskId: 'task-1',
    });
    expect(result.artifacts[0].content).toBe(
      '[remote file reference: https://files.example/result.txt]',
    );
    const headers = new Headers(fetchImpl.mock.calls[0][1].headers);
    expect(headers.get('a2a-version')).toBe('1.0');
  });

  it('falls back from unsupported streaming to send and poll', async () => {
    trust();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'unsupported' }, 404))
      .mockResolvedValueOnce(jsonResponse({ task: task('TASK_STATE_SUBMITTED') }))
      .mockResolvedValueOnce(
        jsonResponse(
          task('TASK_STATE_COMPLETED', {
            history: [
              { messageId: 'answer', parts: [{ text: 'poll result' }], role: 'ROLE_AGENT' },
            ],
          }),
        ),
      );

    const result = await new A2AHttpJsonAdapter(
      binding(),
      fetchImpl as never,
      async () => undefined,
    ).execute({ instruction: 'perform the task', messageId: 'message-1' });

    expect(result).toMatchObject({ outcome: 'completed', summary: 'poll result' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('maps input-required and cancellation to shared execution outcomes', async () => {
    trust();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ task: task('TASK_STATE_INPUT_REQUIRED') }))
      .mockResolvedValueOnce(jsonResponse(task('TASK_STATE_CANCELED')));
    const adapter = new A2AHttpJsonAdapter(
      binding({ interactionMode: 'poll' }),
      fetchImpl as never,
    );

    await expect(
      adapter.execute({ instruction: 'need approval', messageId: 'message-1' }),
    ).resolves.toMatchObject({ outcome: 'input_required' });
    await expect(adapter.cancelTask('task-1')).resolves.toMatchObject({ outcome: 'cancelled' });
  });

  it('sends bearer auth without leaking the secret in HTTP errors', async () => {
    trust();
    vi.stubEnv('A2A_PARTNER_TOKEN', 'do-not-leak');
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'denied' }, 401));
    const adapter = new A2AHttpJsonAdapter(
      binding({ authScheme: 'bearer', credentialRef: 'env:A2A_PARTNER_TOKEN' }),
      fetchImpl as never,
    );

    let error: Error | undefined;
    try {
      await adapter.execute({ instruction: 'perform the task', messageId: 'message-1' });
    } catch (cause) {
      error = cause as Error;
    }
    expect(error).toBeDefined();
    if (!error) throw new Error('Expected A2A execution to fail.');
    expect(error.message).toContain('HTTP 401');
    expect(error.message).not.toContain('do-not-leak');
    const headers = new Headers(fetchImpl.mock.calls[0][1].headers);
    expect(headers.get('authorization')).toBe('Bearer do-not-leak');
  });

  it('rejects redirects and oversized declared responses', async () => {
    trust();
    const redirectFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { headers: { location: 'https://evil.example' }, status: 302 }),
      );
    await expect(
      new A2AHttpJsonAdapter(binding({ interactionMode: 'poll' }), redirectFetch as never).execute({
        instruction: 'perform the task',
        messageId: 'message-1',
      }),
    ).rejects.toThrow('redirects are forbidden');

    const oversizedFetch = vi.fn().mockResolvedValue(
      new Response('{}', {
        headers: { 'content-length': '1048577', 'content-type': 'application/a2a+json' },
      }),
    );
    await expect(
      new A2AHttpJsonAdapter(binding({ interactionMode: 'poll' }), oversizedFetch as never).execute(
        {
          instruction: 'perform the task',
          messageId: 'message-2',
        },
      ),
    ).rejects.toThrow('size limit');
  });
});
