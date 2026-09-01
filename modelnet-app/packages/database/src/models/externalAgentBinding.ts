import type {
  ExternalAgentAuthScheme,
  ExternalAgentInteractionMode,
  ExternalAgentTrustPolicy,
} from '@lobechat/types';
import { and, eq, isNull } from 'drizzle-orm';

import { externalAgentBindings } from '../schemas/externalAgent';
import type { LobeChatDatabase } from '../type';

export interface UpsertExternalAgentBindingParams {
  agentId: string;
  authScheme: ExternalAgentAuthScheme;
  credentialRef?: string;
  enabled?: boolean;
  endpointUrl: string;
  interactionMode: ExternalAgentInteractionMode;
  trustPolicy: ExternalAgentTrustPolicy;
}

/** Owner/workspace-scoped persistence. Callers still authorize Agent manage/use separately. */
export class ExternalAgentBindingModel {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
    private readonly workspaceId?: string,
  ) {}

  private ownership = () =>
    this.workspaceId
      ? eq(externalAgentBindings.workspaceId, this.workspaceId)
      : and(
          eq(externalAgentBindings.userId, this.userId),
          isNull(externalAgentBindings.workspaceId),
        );

  deleteByAgentId = async (agentId: string): Promise<boolean> => {
    const [deleted] = await this.db
      .delete(externalAgentBindings)
      .where(and(eq(externalAgentBindings.agentId, agentId), this.ownership()))
      .returning({ id: externalAgentBindings.id });
    return Boolean(deleted);
  };

  findByAgentId = async (agentId: string) =>
    this.db.query.externalAgentBindings.findFirst({
      where: and(eq(externalAgentBindings.agentId, agentId), this.ownership()),
    });

  findEnabledByAgentId = async (agentId: string) =>
    this.db.query.externalAgentBindings.findFirst({
      where: and(
        eq(externalAgentBindings.agentId, agentId),
        eq(externalAgentBindings.enabled, true),
        this.ownership(),
      ),
    });

  upsert = async (params: UpsertExternalAgentBindingParams) => {
    const [binding] = await this.db
      .insert(externalAgentBindings)
      .values({
        agentId: params.agentId,
        authScheme: params.authScheme,
        credentialRef: params.credentialRef ?? null,
        enabled: params.enabled ?? true,
        endpointUrl: params.endpointUrl,
        interactionMode: params.interactionMode,
        protocolVersion: '1.0',
        transportProfile: 'http-json',
        trustPolicy: params.trustPolicy,
        userId: this.userId,
        workspaceId: this.workspaceId ?? null,
      })
      .onConflictDoUpdate({
        set: {
          authScheme: params.authScheme,
          credentialRef: params.credentialRef ?? null,
          enabled: params.enabled ?? true,
          endpointUrl: params.endpointUrl,
          interactionMode: params.interactionMode,
          protocolVersion: '1.0',
          transportProfile: 'http-json',
          trustPolicy: params.trustPolicy,
          updatedAt: new Date(),
          userId: this.userId,
          workspaceId: this.workspaceId ?? null,
        },
        target: externalAgentBindings.agentId,
      })
      .returning();
    return binding;
  };
}
