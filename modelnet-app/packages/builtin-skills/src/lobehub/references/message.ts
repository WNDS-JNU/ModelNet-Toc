const content = `# modelnet message - Message Management

Manage chat messages.

## Subcommands

- \`modelnet message list [--topic-id <id>] [--agent-id <id>] [-L <limit>] [--page <n>]\` - List messages
- \`modelnet message search <keywords>\` - Search messages by keywords
- \`modelnet message delete <ids...> [--yes]\` - Delete messages
- \`modelnet message count [--start <date>] [--end <date>]\` - Count messages
- \`modelnet message heatmap\` - Get message activity heatmap

## Tips

- Filter by \`--topic-id\` to get messages from a specific conversation
- Use \`--user\` flag to filter by message role (user/assistant)
`;

export default content;
