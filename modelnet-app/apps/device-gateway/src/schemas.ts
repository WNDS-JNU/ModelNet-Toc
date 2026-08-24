import { z } from 'zod';

const identifier = z.string().min(1).max(512);
const optionalIdentifier = identifier.optional();

export const socketQuerySchema = z
  .object({
    channel: z.string().min(1).max(64).optional(),
    connectionId: identifier,
    deviceId: identifier,
    hostname: z.string().min(1).max(255),
    platform: z.string().min(1).max(64),
    userId: optionalIdentifier,
    workspaceId: optionalIdentifier,
  })
  .superRefine((value, context) => {
    if (Boolean(value.userId) === Boolean(value.workspaceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exactly one of userId or workspaceId is required',
      });
    }
  });

export type SocketQuery = z.infer<typeof socketQuerySchema>;

export const authMessageSchema = z.object({
  serverUrl: z.string().url().optional(),
  token: z.string().min(1),
  tokenType: z.enum(['apiKey', 'jwt', 'serviceToken']).default('jwt'),
  type: z.literal('auth'),
});

export type ParsedAuthMessage = z.infer<typeof authMessageSchema>;

export const principalBodySchema = z.object({
  userId: identifier,
  workspaceId: optionalIdentifier,
});

const routedRequestSchema = principalBodySchema.extend({
  deviceId: optionalIdentifier,
  timeout: z.number().int().nonnegative().optional(),
});

export const toolCallBodySchema = routedRequestSchema.extend({
  operationId: optionalIdentifier,
  toolCall: z
    .object({
      apiName: identifier,
      arguments: z.string(),
      identifier,
      params: z
        .object({
          args: z.array(z.string()),
          command: z.string().min(1),
          env: z.record(z.string()).optional(),
          name: z.string().min(1),
          type: z.literal('stdio'),
        })
        .optional(),
      type: z.enum(['tool', 'mcp']).optional(),
    })
    .passthrough(),
});

export const messageApiBodySchema = routedRequestSchema.extend({
  api: z
    .object({
      apiName: identifier,
      payload: z.record(z.unknown()),
      platform: z.string().min(1),
    })
    .passthrough(),
});

export const rpcBodySchema = routedRequestSchema.extend({
  method: identifier,
  params: z.unknown().optional(),
});

export const systemInfoBodySchema = principalBodySchema.extend({
  deviceId: identifier,
  timeout: z.number().int().nonnegative().optional(),
});

export const agentRunBodySchema = routedRequestSchema.extend({
  agentType: identifier,
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  imageList: z.array(z.object({ id: z.string().optional(), url: z.string().url() })).optional(),
  jwt: z.string().min(1),
  operationId: identifier,
  prompt: z.string(),
  resumeSessionId: optionalIdentifier,
  systemContext: z.string().optional(),
  topicId: identifier,
});
