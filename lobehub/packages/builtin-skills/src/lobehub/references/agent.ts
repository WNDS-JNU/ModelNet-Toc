const content = `# modelnet agent - Agent Management

Manage agents (AI assistants with custom configurations).

## Subcommands

- \`modelnet agent list [-L <limit>] [-k <keyword>]\` - List agents
- \`modelnet agent view [agentId] [-s <slug>]\` - View agent configuration
- \`modelnet agent create -t <title> [-d <description>] [-m <model>] [-p <provider>] [-s <systemRole>]\` - Create agent
- \`modelnet agent edit [agentId] [-t <title>] [-d <description>] [-m <model>] [-s <systemRole>]\` - Update agent
- \`modelnet agent delete <agentId> [--yes]\` - Delete agent
- \`modelnet agent duplicate <agentId> [-t <title>]\` - Duplicate agent
- \`modelnet agent run -a <agentId> -p <prompt> [-t <topicId>] [--replay]\` - Run agent with a prompt
- \`modelnet agent status <operationId> [--history]\` - Check agent operation status

## Tips

- Use \`--slug\` to reference agents by slug instead of ID
- \`modelnet agent run --replay\` replays the full conversation output
- \`modelnet agent status --history\` shows operation execution history
`;

export default content;
