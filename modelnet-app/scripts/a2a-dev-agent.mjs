import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const tasks = new Map();
const port = Number(process.env.PORT || 3400);

const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/a2a+json' });
  response.end(JSON.stringify(body));
};

const task = (id, contextId, state, message, artifacts) => ({
  ...(artifacts ? { artifacts } : {}),
  contextId,
  history: message
    ? [{ messageId: randomUUID(), parts: [{ text: message }], role: 'ROLE_AGENT' }]
    : [],
  id,
  status: {
    ...(message
      ? {
          message: {
            contextId,
            messageId: randomUUID(),
            parts: [{ text: message }],
            role: 'ROLE_AGENT',
            taskId: id,
          },
        }
      : {}),
    state,
  },
});

const completedTask = (id, contextId, instruction) =>
  task(id, contextId, 'TASK_STATE_COMPLETED', `Trusted dev Agent completed: ${instruction}`, [
    {
      artifactId: 'report',
      description: 'A2A Dev acceptance artifact',
      name: 'report.txt',
      parts: [{ mediaType: 'text/plain', text: `artifact:${instruction}` }],
    },
  ]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return json(response, 200, { protocolVersion: '1.0', status: 'ok' });
    }

    if (request.method === 'POST' && url.pathname === '/a2a/message:stream') {
      const body = await readJson(request);
      const instruction = body.message?.parts?.[0]?.text || '';
      const id = body.message?.taskId || `task-${randomUUID()}`;
      const contextId = body.message?.contextId || `context-${randomUUID()}`;
      const inputRequired =
        instruction.includes('MODELNET_A2A_INPUT_REQUIRED') && !body.message?.taskId;
      const terminal = inputRequired
        ? task(id, contextId, 'TASK_STATE_INPUT_REQUIRED', 'Provide the approval code.')
        : completedTask(id, contextId, instruction);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'connection': 'keep-alive',
        'content-type': 'text/event-stream',
      });
      response.write(
        `data: ${JSON.stringify({ task: task(id, contextId, 'TASK_STATE_WORKING') })}\n\n`,
      );
      response.end(`data: ${JSON.stringify({ task: terminal })}\n\n`);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/a2a/message:send') {
      const body = await readJson(request);
      const instruction = body.message?.parts?.[0]?.text || '';
      const id = body.message?.taskId || `task-${randomUUID()}`;
      const contextId = body.message?.contextId || `context-${randomUUID()}`;
      tasks.set(id, { contextId, instruction, polls: 0 });
      return json(response, 200, { task: task(id, contextId, 'TASK_STATE_SUBMITTED') });
    }

    const match = url.pathname.match(/^\/a2a\/tasks\/([^/:]+)(:cancel)?$/);
    if (match && request.method === 'POST' && match[2] === ':cancel') {
      const existing = tasks.get(match[1]);
      return json(
        response,
        200,
        task(match[1], existing?.contextId || 'context-cancelled', 'TASK_STATE_CANCELED'),
      );
    }
    if (match && request.method === 'GET' && !match[2]) {
      const existing = tasks.get(match[1]);
      if (!existing) return json(response, 404, { error: 'task not found' });
      existing.polls += 1;
      return json(
        response,
        200,
        existing.polls > 1
          ? completedTask(match[1], existing.contextId, existing.instruction)
          : task(match[1], existing.contextId, 'TASK_STATE_WORKING'),
      );
    }

    return json(response, 404, { error: 'not found' });
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.info(`[a2a-dev-agent] listening on ${port}`);
});
