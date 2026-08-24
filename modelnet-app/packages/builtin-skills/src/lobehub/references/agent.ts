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

## Editing your own configuration

You can edit yourself: pass your own agent id (already given to you in the
identity table) to \`lh agent edit\`.

Fields without a dedicated flag (\`openingMessage\`, \`openingQuestions\`, \`tags\`,
\`avatar\`, \`backgroundColor\`, \`params\`, \`chatConfig\`, …) go through
\`--config-file\`, which is deep-merged into the existing config — omitted keys
are kept:

\`\`\`bash
echo '{"openingMessage":"Hi! Ask me about deploys.","tags":["devops"]}' > /tmp/cfg.json
lh agent edit <agentId> --config-file /tmp/cfg.json --json
\`\`\`

Identity fields (\`id\`, \`slug\`, \`userId\`, \`workspaceId\`, \`visibility\`) are
rejected by the server — use the dedicated commands for those.

Add \`--json\` to get the updated agent back, so you can confirm the change
actually landed instead of assuming it did.

## Tips

- Use \`--slug\` to reference agents by slug instead of ID
- \`modelnet agent run --replay\` replays the full conversation output
- \`modelnet agent status --history\` shows operation execution history
`;

export default content;
