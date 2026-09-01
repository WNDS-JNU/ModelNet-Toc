import type { BuiltinToolManifest } from '@lobechat/types';

import { isDesktop } from './const';
import { systemPrompt } from './systemRole';
import { GroupManagementApiName } from './types';

export const GroupManagementIdentifier = 'lobe-group-management';

export const GroupManagementManifest: BuiltinToolManifest = {
  api: [
    // ==================== Communication Coordination ====================
    {
      description:
        "Let a specific agent speak in the conversation. This is synchronous and waits for the agent's response. Use this for focused, single-agent interactions.",
      name: GroupManagementApiName.speak,
      parameters: {
        properties: {
          agentId: {
            description: 'The ID of the agent who should respond.',
            type: 'string',
          },
          instruction: {
            description:
              "Optional instruction or context to guide the agent's response. If omitted, the agent responds based on conversation context.",
            type: 'string',
          },
          skipCallSupervisor: {
            default: false,
            description:
              'If true, the orchestration will end after this agent responds, without calling the supervisor again. Use this when the user explicitly requests a specific agent (e.g., "@Designer, help me review this UI") and no further orchestration is needed.',
            type: 'boolean',
          },
        },
        required: ['agentId'],
        type: 'object',
      },
    },
    {
      description:
        'Let multiple agents respond simultaneously. All specified agents will generate responses in parallel, providing multiple perspectives. Use this when diverse viewpoints are valuable.',
      name: GroupManagementApiName.broadcast,
      parameters: {
        properties: {
          agentIds: {
            description: 'Array of agent IDs who should respond.',
            items: { type: 'string' },
            type: 'array',
          },
          instruction: {
            description:
              'Optional shared instruction for all agents. Each agent interprets it based on their role.',
            type: 'string',
          },
          skipCallSupervisor: {
            default: false,
            description:
              'If true, the orchestration will end after all agents respond, without calling the supervisor again. Use this when the user explicitly requests specific agents and no further orchestration is needed.',
            type: 'boolean',
          },
        },
        required: ['agentIds'],
        type: 'object',
      },
    },
    // {
    //   description:
    //     'Delegate the conversation entirely to a specific agent. The supervisor exits orchestration mode and the delegated agent takes full control until explicitly recalled.',
    //   name: GroupManagementApiName.delegate,
    //   parameters: {
    //     properties: {
    //       agentId: {
    //         description: 'The ID of the agent to delegate the conversation to.',
    //         type: 'string',
    //       },
    //       reason: {
    //         description:
    //           'Brief explanation of why delegation is appropriate. Helps maintain conversation continuity.',
    //         type: 'string',
    //       },
    //     },
    //     required: ['agentId'],
    //     type: 'object',
    //   },
    // },

    // ==================== Task Execution ====================
    {
      description:
        'Assign an asynchronous task to an agent. The task runs in the background and results are returned to the conversation context upon completion. Ideal for longer operations.',
      name: GroupManagementApiName.executeAgentTask,
      humanIntervention: 'required',
      parameters: {
        properties: {
          agentId: {
            description: 'The ID of the agent to execute the task.',
            type: 'string',
          },
          title: {
            description: 'Brief title describing what this task does (shown in UI).',
            type: 'string',
          },
          instruction: {
            description:
              'Clear instruction describing the task to perform. Be specific about expected deliverables.',
            type: 'string',
          },
          ...(isDesktop && {
            runInClient: {
              description:
                'Whether to run on the desktop client (for local file/shell access). MUST be true when task requires local-system tools. Default is false (server execution).',
              type: 'boolean',
            },
          }),
          timeout: {
            default: 1_800_000,
            description:
              'Maximum time in milliseconds to wait for task completion (default: 1800000, 30 minutes).',
            type: 'number',
          },
          skipCallSupervisor: {
            default: false,
            description:
              'If true, the orchestration will end after the task completes, without calling the supervisor again. Use this when the task is the final action needed.',
            type: 'boolean',
          },
        },
        required: ['agentId', 'title', 'instruction'],
        type: 'object',
      },
    },
    {
      description:
        'Assign multiple tasks to different agents to run in parallel. Each agent works independently in their own context. Use this when you need multiple agents to work on different parts of a problem simultaneously.',
      name: GroupManagementApiName.executeAgentTasks,
      humanIntervention: 'required',
      parameters: {
        properties: {
          tasks: {
            description: 'Array of tasks, each assigned to a specific agent.',
            items: {
              properties: {
                agentId: {
                  description: 'The ID of the agent to execute this task.',
                  type: 'string',
                },
                title: {
                  description: 'Brief title describing what this task does (shown in UI).',
                  type: 'string',
                },
                instruction: {
                  description:
                    'Detailed instruction for the agent to execute. Be specific about expected deliverables.',
                  type: 'string',
                },
                timeout: {
                  description:
                    'Optional timeout in milliseconds for this task (default: 1800000, 30 minutes).',
                  type: 'number',
                },
              },
              required: ['agentId', 'title', 'instruction'],
              type: 'object',
            },
            type: 'array',
          },
          skipCallSupervisor: {
            default: false,
            description:
              'If true, the orchestration will end after all tasks complete, without calling the supervisor again.',
            type: 'boolean',
          },
        },
        required: ['tasks'],
        type: 'object',
      },
    },
    // {
    //   description:
    //     'Interrupt a running agent task. Use this to stop a task that is taking too long or is no longer needed.',
    //   humanIntervention: 'always',
    //   name: GroupManagementApiName.interrupt,
    //   parameters: {
    //     properties: {
    //       taskId: {
    //         description: 'The ID of the task to interrupt (returned by executeTask).',
    //         type: 'string',
    //       },
    //     },
    //     required: ['taskId'],
    //     type: 'object',
    //   },
    // },

    // ==================== Context Management ====================
    // {
    //   description:
    //     'Summarize the current conversation and compress the context. Useful for long conversations to maintain relevant information while reducing token usage.',
    //   name: GroupManagementApiName.summarize,
    //   parameters: {
    //     properties: {
    //       focus: {
    //         description:
    //           'Optional focus area for the summary (e.g., "decisions made", "action items", "key points").',
    //         type: 'string',
    //       },
    //       preserveRecent: {
    //         default: 5,
    //         description: 'Number of recent messages to preserve in full detail (default: 5).',
    //         minimum: 0,
    //         type: 'number',
    //       },
    //     },
    //     required: [],
    //     type: 'object',
    //   },
    // },

    // ==================== Flow Control ====================
    // {
    //   description:
    //     'Define a multi-agent collaboration workflow. Creates a structured sequence of agent interactions for complex tasks.',
    //   name: GroupManagementApiName.createWorkflow,
    //   parameters: {
    //     properties: {
    //       name: {
    //         description: 'A descriptive name for this workflow.',
    //         type: 'string',
    //       },
    //       steps: {
    //         description: 'Array of workflow steps defining agent participation order.',
    //         items: {
    //           properties: {
    //             agentId: {
    //               description: 'The ID of the agent for this step.',
    //               type: 'string',
    //             },
    //             instruction: {
    //               description: 'Specific instruction for this step.',
    //               type: 'string',
    //             },
    //             waitForCompletion: {
    //               default: true,
    //               description: 'Whether to wait for this step before proceeding (default: true).',
    //               type: 'boolean',
    //             },
    //           },
    //           required: ['agentId'],
    //           type: 'object',
    //         },
    //         type: 'array',
    //       },
    //       autoExecute: {
    //         default: false,
    //         description:
    //           'Whether to immediately execute the workflow after creation (default: false).',
    //         type: 'boolean',
    //       },
    //     },
    //     required: ['name', 'steps'],
    //     type: 'object',
    //   },
    // },
    {
      description:
        'Propose a durable fixed-round multi-agent Debate as an editable draft. The user must explicitly approve the participants, perspectives, rounds, budgets, and final Judge before the server creates or dispatches any Run.',
      humanIntervention: 'required',
      name: GroupManagementApiName.createDebate,
      parameters: {
        properties: {
          budget: {
            description: 'Optional immutable total Debate budget captured with the approved Run.',
            properties: {
              maxDurationMs: { minimum: 1, type: 'number' },
              maxParallel: { minimum: 1, type: 'number' },
              maxTotalCost: { minimum: 0, type: 'number' },
            },
            type: 'object',
          },
          judgeAgentId: {
            description: 'ID of the enabled group member that issues the final verdict.',
            type: 'string',
          },
          judgeInstruction: {
            description: 'Optional explicit judging criteria for the final verdict.',
            type: 'string',
          },
          judgeTimeoutMs: {
            description: 'Optional timeout for the final Judge node in milliseconds.',
            minimum: 1,
            type: 'number',
          },
          motion: {
            description: 'The exact proposition or question debated in every round.',
            type: 'string',
          },
          name: {
            description: 'A short user-visible name for the Debate draft.',
            type: 'string',
          },
          participants: {
            description: 'Two to eight fixed Debate participants. The Judge must be distinct.',
            items: {
              properties: {
                agentId: {
                  description: 'ID of an enabled group member.',
                  type: 'string',
                },
                perspective: {
                  description: 'Optional assigned position or perspective for this participant.',
                  type: 'string',
                },
              },
              required: ['agentId'],
              type: 'object',
            },
            maxItems: 8,
            minItems: 2,
            type: 'array',
          },
          policy: {
            description: 'Optional immutable failure policy.',
            properties: {
              failureStrategy: {
                enum: ['fail_fast', 'wait_all'],
                type: 'string',
              },
            },
            type: 'object',
          },
          roundBudget: {
            description: 'Budget applied to every participant turn.',
            properties: {
              maxAttempts: { maximum: 3, minimum: 1, type: 'number' },
              timeoutMs: { minimum: 1, type: 'number' },
            },
            type: 'object',
          },
          rounds: {
            description: 'Fixed number of Debate rounds before the Judge runs (1-5).',
            maximum: 5,
            minimum: 1,
            type: 'number',
          },
        },
        required: ['name', 'motion', 'participants', 'rounds', 'judgeAgentId'],
        type: 'object',
      },
    },
    {
      description:
        'Propose a durable multi-agent Pipeline as an editable draft. The user must explicitly approve the draft before the server creates or dispatches any Run. Use dependencies to express a DAG; steps without dependencies start in parallel.',
      humanIntervention: 'required',
      name: GroupManagementApiName.createWorkflow,
      parameters: {
        properties: {
          budget: {
            description: 'Optional immutable execution budget captured with the approved Run.',
            properties: {
              maxDurationMs: {
                description: 'Optional maximum wall-clock duration in milliseconds.',
                minimum: 1,
                type: 'number',
              },
              maxParallel: {
                description: 'Maximum number of Pipeline nodes allowed to run concurrently.',
                minimum: 1,
                type: 'number',
              },
              maxTotalCost: {
                description: 'Optional maximum total execution cost.',
                minimum: 0,
                type: 'number',
              },
            },
            type: 'object',
          },
          name: {
            description: 'A short user-visible name for the workflow draft.',
            type: 'string',
          },
          policy: {
            description: 'Optional immutable failure and approval policy.',
            properties: {
              failureStrategy: {
                description: 'Whether one failed node fails fast or waits for active nodes.',
                enum: ['fail_fast', 'wait_all'],
                type: 'string',
              },
              requireHumanApprovalForWrites: {
                description: 'Require human approval before member tools perform writes.',
                type: 'boolean',
              },
            },
            type: 'object',
          },
          steps: {
            description:
              'Pipeline nodes. dependencies contains keys of prerequisite nodes; an empty list makes a root node.',
            items: {
              properties: {
                agentId: {
                  description: 'ID of an enabled member of the current Agent Group.',
                  type: 'string',
                },
                barrierKey: {
                  description: 'Optional logical barrier label for UI and audit grouping.',
                  type: 'string',
                },
                dependencies: {
                  description: 'Keys of prerequisite steps that must complete first.',
                  items: { type: 'string' },
                  type: 'array',
                },
                instruction: {
                  description: 'Clear task and expected deliverable for this node.',
                  type: 'string',
                },
                key: {
                  description:
                    'Stable unique node key (letters, numbers, underscore, dot, or hyphen; maximum 64 characters).',
                  type: 'string',
                },
                maxAttempts: {
                  default: 1,
                  description: 'Maximum attempts for this node (1-10).',
                  maximum: 10,
                  minimum: 1,
                  type: 'number',
                },
                role: {
                  description:
                    'Optional collaboration role such as researcher, writer, or reviewer.',
                  type: 'string',
                },
                timeoutMs: {
                  description: 'Optional node timeout in milliseconds.',
                  minimum: 1,
                  type: 'number',
                },
                toolPolicy: {
                  description: 'Optional immutable tool restriction for this node.',
                  properties: {
                    allowedToolIds: {
                      items: { type: 'string' },
                      type: 'array',
                    },
                    deniedToolIds: {
                      items: { type: 'string' },
                      type: 'array',
                    },
                    disableTools: {
                      type: 'boolean',
                    },
                  },
                  type: 'object',
                },
              },
              required: ['key', 'agentId', 'instruction'],
              type: 'object',
            },
            minItems: 1,
            maxItems: 64,
            type: 'array',
          },
        },
        required: ['name', 'steps'],
        type: 'object',
      },
    },
    {
      description:
        'Initiate a vote among agents on a specific question or decision. Each agent provides their choice and reasoning.',
      name: GroupManagementApiName.vote,
      parameters: {
        properties: {
          question: {
            description: 'The question or decision to vote on.',
            type: 'string',
          },
          options: {
            description: 'Array of voting options.',
            items: {
              properties: {
                id: {
                  description: 'Unique identifier for this option.',
                  type: 'string',
                },
                label: {
                  description: 'Display label for this option.',
                  type: 'string',
                },
                description: {
                  description: 'Optional description explaining this option.',
                  type: 'string',
                },
              },
              required: ['id', 'label'],
              type: 'object',
            },
            type: 'array',
          },
          voterAgentIds: {
            description: 'Array of agent IDs who should vote. If omitted, all group members vote.',
            items: { type: 'string' },
            type: 'array',
          },
          requireReasoning: {
            default: true,
            description: 'Whether agents must provide reasoning for their vote (default: true).',
            type: 'boolean',
          },
        },
        required: ['question', 'options'],
        type: 'object',
      },
    },
  ],
  identifier: GroupManagementIdentifier,
  meta: {
    avatar: '👥',
    description: 'Orchestrate and manage multi-agent group conversations',
    title: 'Group Management',
  },
  systemRole: systemPrompt,
  type: 'builtin',
};

export { GroupManagementApiName } from './types';
