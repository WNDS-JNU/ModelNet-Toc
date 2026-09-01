import type { AgentGroupCollaborationMode, UIChatMessage } from '@lobechat/types';
import { agentDisplayName } from '@lobechat/types';

const collaborationModeInstructions: Record<
  Exclude<AgentGroupCollaborationMode, 'auto'>,
  string
> = {
  broadcast: `The user explicitly selected BROADCAST collaboration for this turn.
You MUST call the lobe-group-management broadcast tool and ask the relevant group members to answer in parallel. Do not replace it with direct speech, task delegation, a workflow, or a debate. After the member responses arrive, synthesize them for the user.`,
  debate: `The user explicitly selected DEBATE collaboration for this turn.
You MUST call the lobe-group-management createDebate tool to propose a structured multi-agent debate. Do not simulate the debate in plain text and do not replace it with broadcast or parallel tasks. Let the normal approval flow confirm the debate before execution.`,
  parallel_tasks: `The user explicitly selected PARALLEL TASKS collaboration for this turn.
You MUST decompose the request into independent assignments and call the lobe-group-management executeAgentTasks tool. Do not replace it with broadcast, sequential speak calls, a workflow, or a debate. Integrate the completed task results into one answer.`,
  pipeline: `The user explicitly selected PIPELINE collaboration for this turn.
You MUST call the lobe-group-management createWorkflow tool to propose an ordered multi-agent workflow. Do not emulate a pipeline with ad-hoc delegation or plain text. Let the normal approval flow confirm the workflow before execution.`,
  single: `The user explicitly selected SINGLE AGENT collaboration for this turn.
Answer the request yourself as the group Supervisor. Do not call any lobe-group-management orchestration tool and do not delegate to group members.`,
};

/** Return the run-scoped Supervisor constraint for an explicit collaboration choice. */
export const buildAgentGroupCollaborationModeInstruction = (
  mode?: AgentGroupCollaborationMode,
): string | undefined =>
  mode && mode !== 'auto' ? collaborationModeInstructions[mode] : undefined;

/** Merge an explicit turn mode after the group's persistent prompt so it wins for this run. */
export const mergeAgentGroupCollaborationSystemPrompt = (
  systemPrompt: string | null | undefined,
  mode?: AgentGroupCollaborationMode,
): string | undefined => {
  const instruction = buildAgentGroupCollaborationModeInstruction(mode);
  const sections = [systemPrompt?.trim(), instruction].filter(Boolean);
  return sections.length > 0 ? sections.join('\n\n') : undefined;
};

export interface GroupMemberInfo {
  id: string;
  title: string;
}

export interface SupervisorTodoItem {
  assignee?: string;
  content: string;
  finished: boolean;
}

const buildGroupMembersTag = (members: GroupMemberInfo[]): string => {
  if (!members || members.length === 0) return '';
  const memberList = members
    .map((member) => `  <member id="${member.id}" title="${member.title}" />`)
    .join('\n');
  return `<group_members>\n${memberList}\n</group_members>`;
};

export const buildGroupChatSystemPrompt = ({
  baseSystemRole = '',
  agentId,
  groupMembers,
  targetId,
  instruction,
}: {
  agentId: string;
  baseSystemRole?: string;
  groupMembers: GroupMemberInfo[];
  instruction?: string;
  messages: UIChatMessage[];
  targetId?: string;
}): string => {
  const membersTag = buildGroupMembersTag(groupMembers);

  const agentTitle = groupMembers.find((m) => m.id === agentId)?.title || 'Agent';

  const guidelines = [
    `Stay in character as ${agentId} (${agentTitle})`,
    'Be concise and natural, behave like a real person',
    "The group supervisor will decide whether to send it privately or publicly, so you just need to say the actuall content, even it's a DM to a specific member. Do not pretend you've sent it.",
    "Be collaborative and build upon others' responses when appropriate",
    'Keep your responses concise and relevant to the ongoing discussion',
  ];

  const guidelinesSection = ['Guidelines:', '', ...guidelines.map((line) => `- ${line}`)].join(
    '\n',
  );

  const sections = [baseSystemRole, guidelinesSection];

  if (membersTag) sections.push(membersTag);

  // Add response instruction at the end
  const targetText = targetId ? targetId : 'the group publicly';
  const instructionText = instruction ? `SUPERVISOR INSTRUCTION: ${instruction}` : '';
  const responseInstruction =
    `Now it's your turn to respond. ${instructionText} You are sending message to ${targetText}. Please respond as this agent would, considering the full conversation history provided above. Directly return the message content, no other text. You do not need add author name or anything else.`.trim();

  sections.push(responseInstruction);

  return sections.filter(Boolean).join('\n\n').trim();
};

export interface SupervisorPromptParams {
  allowDM?: boolean;
  availableAgents: Array<{ id: string; name?: string | null; title?: string | null }>;
  conversationHistory: string;
  scene?: 'casual' | 'productive';
  systemPrompt?: string;
  todoList?: SupervisorTodoItem[];
  userName?: string;
}

const buildTodoListTag = (todoList?: SupervisorTodoItem[]): string => {
  if (!todoList || todoList.length === 0) return '';

  const serialized = JSON.stringify(todoList && todoList.length > 0 ? todoList : [], null, 2);
  return `<todo_list>\n${serialized}\n</todo_list>`;
};

export const buildSupervisorPrompt = ({
  allowDM = true,
  scene = 'productive',
  availableAgents,
  conversationHistory,
  todoList,
  systemPrompt,
  userName,
}: SupervisorPromptParams): string => {
  const members = [
    {
      id: 'user',
      name: userName || 'User',
      role: 'user',
    },
    // Then include all agents
    ...availableAgents.map((agent) => ({
      id: agent.id,
      name: agentDisplayName(agent, agent.id),
      role: 'assistant',
    })),
  ];

  const memberList = members
    .map((member) => `  <member id="${member.id}" name="${member.name}" />`)
    .join('\n');

  const todoListTag = scene === 'productive' ? buildTodoListTag(todoList) : '';

  // Build rules and examples for DM usage
  const dmRules = allowDM
    ? `- To send a private message, use "trigger_agent_dm" and set "target" to the recipient agent id or "user".
- Use public messages by default; choose DM only when the message MUST be private.`
    : '';

  const prompt = `
You are a conversation supervisor for a group chat with multiple AI agents. Your role is to orchestrate a group of agents to make user feel natural and interactive.

<group_role>
${systemPrompt || ''}
</group_role>

<group_members>
${memberList}
</group_members>

<conversation_history>
${conversationHistory}
</conversation_history>

${todoListTag}

RULES:

- Do not forcing user to respond, only ask for information for one time before you get the information you need.
- Make the group conversation feels like a real conversation.

WHEN ASKING AGENTS TO SPEAK:

- Only reference agents from the member list. Never invent new IDs.
- Do not excessivly gathering information from user, you should only ask for information when it's necessary.
- If need many information from user, make single agent to ask for all.
${dmRules}

${
  scene === 'productive'
    ? `WHEN GENERATING TODOS:

- Only use Todo for complex tasks.
- Break down the main objective into logical, sequential tasks.
- Be concise and to the point. Each todo should no longer than 10 words. Do not create more than 5 todos.
- Match user's message language.
- By only assigning todo will not tirgger agent response you still need to use trigger tool if needed.
- Keep todo items synchronized with the context. Finish or create todos as progress changes.`
    : ''
}
`;

  return prompt.trim();
};

export const groupChatPrompts = {
  buildAgentGroupCollaborationModeInstruction,
  buildGroupChatSystemPrompt,
  buildSupervisorPrompt,
  mergeAgentGroupCollaborationSystemPrompt,
};
