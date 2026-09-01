export { A2AHttpError, A2AHttpJsonAdapter } from './A2AHttpJsonAdapter';
export type {
  ExternalAgentOperationMetadata,
  PreparedExternalAgentOperation,
  PrepareExternalAgentOperationParams,
} from './ExternalAgentExecutionService';
export {
  createExternalAgentExecutionService,
  ExternalAgentExecutionService,
  parseExternalAgentOperationMetadata,
} from './ExternalAgentExecutionService';
export {
  assertExternalAgentBindingPolicy,
  normalizeExternalAgentEndpoint,
  resolveExternalAgentCredential,
  resolveExternalAgentTrustPolicy,
  validateExternalAgentCredentialRef,
} from './trust';
export type * from './types';
