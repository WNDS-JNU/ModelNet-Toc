import type {
  ExternalAgentAuthScheme,
  ExternalAgentInteractionMode,
  ExternalAgentTransportProfile,
  ExternalAgentTrustPolicy,
} from '@lobechat/types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { timestamps } from './_helpers';
import { agents } from './agent';
import { users } from './user';
import { workspaces } from './workspace';

/** Server-only binding from a stable local Agent identity to one trusted A2A interface. */
export const externalAgentBindings = pgTable(
  'external_agent_bindings',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),
    agentId: text('agent_id')
      .references(() => agents.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    endpointUrl: text('endpoint_url').notNull(),
    protocolVersion: text('protocol_version').default('1.0').notNull(),
    transportProfile: text('transport_profile')
      .$type<ExternalAgentTransportProfile>()
      .default('http-json')
      .notNull(),
    interactionMode: text('interaction_mode')
      .$type<ExternalAgentInteractionMode>()
      .default('stream')
      .notNull(),
    authScheme: text('auth_scheme').$type<ExternalAgentAuthScheme>().default('none').notNull(),
    /** Opaque server-side secret locator (v1: env:A2A_*), never a credential value. */
    credentialRef: text('credential_ref'),
    trustPolicy: jsonb('trust_policy').$type<ExternalAgentTrustPolicy>().notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('external_agent_bindings_agent_unique').on(t.agentId),
    index('external_agent_bindings_owner_idx').on(t.userId, t.workspaceId),
    check('external_agent_bindings_protocol_v1', sql`${t.protocolVersion} = '1.0'`),
    check('external_agent_bindings_transport_http_json', sql`${t.transportProfile} = 'http-json'`),
    check(
      'external_agent_bindings_interaction_mode',
      sql`${t.interactionMode} IN ('stream', 'poll')`,
    ),
    check('external_agent_bindings_auth_scheme', sql`${t.authScheme} IN ('none', 'bearer')`),
    check(
      'external_agent_bindings_credential_pair',
      sql`(${t.authScheme} = 'none' AND ${t.credentialRef} IS NULL) OR (${t.authScheme} = 'bearer' AND ${t.credentialRef} IS NOT NULL)`,
    ),
  ],
);

export type ExternalAgentBindingItem = typeof externalAgentBindings.$inferSelect;
export type NewExternalAgentBinding = typeof externalAgentBindings.$inferInsert;
