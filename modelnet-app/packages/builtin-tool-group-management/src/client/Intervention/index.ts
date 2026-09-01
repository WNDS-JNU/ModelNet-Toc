import type { BuiltinIntervention } from '@lobechat/types';

import { GroupManagementApiName } from '../../types';
import CreateDebateIntervention from './CreateDebate';
import CreateWorkflowIntervention from './CreateWorkflow';
import ExecuteTaskIntervention from './ExecuteTask';
import ExecuteTasksIntervention from './ExecuteTasks';

/**
 * Group Management Tool Intervention Components Registry
 *
 * Intervention components allow users to review and modify tool parameters
 * before the tool is executed.
 */
export const GroupManagementInterventions: Record<string, BuiltinIntervention> = {
  [GroupManagementApiName.createDebate]: CreateDebateIntervention as BuiltinIntervention,
  [GroupManagementApiName.createWorkflow]: CreateWorkflowIntervention as BuiltinIntervention,
  [GroupManagementApiName.executeAgentTask]: ExecuteTaskIntervention as BuiltinIntervention,
  [GroupManagementApiName.executeAgentTasks]: ExecuteTasksIntervention as BuiltinIntervention,
};

export { default as CreateDebateIntervention } from './CreateDebate';
export { default as CreateWorkflowIntervention } from './CreateWorkflow';
export { default as ExecuteTaskIntervention } from './ExecuteTask';
export { default as ExecuteTasksIntervention } from './ExecuteTasks';
