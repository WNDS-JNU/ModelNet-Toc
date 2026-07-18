const content = `# modelnet memory - User Memory Management

Manage user memories across five categories: identity, activity, context, experience, preference.

## Subcommands

- \`modelnet memory list [category]\` - List memories by category
- \`modelnet memory create --type <type> --role <role> -d <description>\` - Create identity memory
- \`modelnet memory edit <category> <id> [options]\` - Update memory entry
- \`modelnet memory delete <category> <id> [--yes]\` - Delete memory entry
- \`modelnet memory persona\` - View memory persona summary
- \`modelnet memory extract [--from <date>] [--to <date>]\` - Extract memories from chat history
- \`modelnet memory extract-status --task-id <id>\` - Check extraction task status

## Memory Categories

- **identity** - Who the user is (role, relationships, descriptions)
- **activity** - What the user does (events, actions, habits)
- **context** - Situational context (environment, constraints)
- **experience** - Past experiences and learnings
- **preference** - User preferences and settings

## Tips

- Use \`modelnet memory persona\` to get a comprehensive view of the user
- Memory extraction analyzes chat history to automatically create entries
`;

export default content;
