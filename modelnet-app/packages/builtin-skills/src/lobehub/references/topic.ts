const content = `# modelnet topic - Conversation Topic Management

Manage conversation topics (chat sessions).

## Subcommands

- \`modelnet topic list [--agent-id <id>] [-L <limit>] [--page <n>]\` - List topics with pagination
- \`modelnet topic search <keywords> [--agent-id <id>]\` - Search topics by keywords
- \`modelnet topic create -t <title> [--agent-id <id>] [--favorite]\` - Create a topic
- \`modelnet topic edit <id> [-t <title>] [--favorite] [--no-favorite]\` - Update topic
- \`modelnet topic delete <ids...> [--yes]\` - Delete one or more topics
- \`modelnet topic recent [-L <limit>]\` - List recently accessed topics

## Tips

- Topics are associated with agents; use \`--agent-id\` to filter
- Use \`--json\` for structured output suitable for piping
`;

export default content;
