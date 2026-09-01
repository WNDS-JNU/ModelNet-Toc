export const MODELNET_A2A_PROTOCOL_VERSION = '1.0' as const;

export type ExternalAgentAuthScheme = 'bearer' | 'none';
export type ExternalAgentInteractionMode = 'poll' | 'stream';
export type ExternalAgentTransportProfile = 'http-json';

/**
 * Immutable network policy copied onto an external Agent binding.
 * Deployment allowlists remain the authority; these values only narrow it.
 */
export interface ExternalAgentTrustPolicy {
  allowedOrigin: string;
  allowInsecureHttp: boolean;
  allowPrivateNetwork: boolean;
  maxResponseBytes: number;
  requestTimeoutMs: number;
}

/** One stable local Agent -> trusted remote A2A interface binding. */
export interface ExternalAgentBinding {
  agentId: string;
  authScheme: ExternalAgentAuthScheme;
  credentialRef?: null | string;
  enabled: boolean;
  endpointUrl: string;
  id: string;
  interactionMode: ExternalAgentInteractionMode;
  protocolVersion: typeof MODELNET_A2A_PROTOCOL_VERSION;
  transportProfile: ExternalAgentTransportProfile;
  trustPolicy: ExternalAgentTrustPolicy;
  userId: string;
  workspaceId?: null | string;
}
