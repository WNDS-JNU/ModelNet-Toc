const content = `# modelnet bot - Bot Integration Management

Manage bot integrations that connect agents to messaging platforms.

## Supported Platforms

Discord, Slack, Telegram, Lark, Feishu

## Subcommands

- \`modelnet bot list [-a <agentId>] [--platform <p>]\` - List bot integrations
- \`modelnet bot view <botId> [-a <agentId>]\` - View bot details
- \`modelnet bot add -a <agentId> --platform <p> [--bot-token <t>] [--app-id <id>]\` - Add bot to agent
- \`modelnet bot update <botId> [--bot-token <t>] [--platform <p>]\` - Update bot credentials
- \`modelnet bot remove <botId> [--yes]\` - Remove bot integration
- \`modelnet bot enable <botId>\` - Enable bot
- \`modelnet bot disable <botId>\` - Disable bot
- \`modelnet bot connect <botId> [-a <agentId>]\` - Connect and start bot

## Message Subcommands

- \`modelnet bot message send <botId> --target <channelId> --message <text> [--reply-to <messageId>] [--json]\` - Send a message
- \`modelnet bot message read <botId> --target <channelId> [--limit <n>] [--before <messageId>] [--after <messageId>] [--json]\` - Read messages from a channel
- \`modelnet bot message edit <botId> --target <channelId> --message-id <id> --message <text>\` - Edit a message
- \`modelnet bot message delete <botId> --target <channelId> --message-id <id> [--yes]\` - Delete a message
- \`modelnet bot message search <botId> --target <channelId> --query <text> [--author-id <id>] [--limit <n>] [--json]\` - Search messages
- \`modelnet bot message react <botId> --target <channelId> --message-id <id> --emoji <emoji>\` - Add reaction
- \`modelnet bot message reactions <botId> --target <channelId> --message-id <id> [--json]\` - List reactions
- \`modelnet bot message pin <botId> --target <channelId> --message-id <id>\` - Pin a message
- \`modelnet bot message unpin <botId> --target <channelId> --message-id <id>\` - Unpin a message
- \`modelnet bot message pins <botId> --target <channelId> [--json]\` - List pinned messages
- \`modelnet bot message poll <botId> --target <channelId> --poll-question <text> --poll-option <opt> [--poll-multi] [--poll-duration-hours <n>]\` - Create a poll
- \`modelnet bot message thread create <botId> --target <channelId> --thread-name <name> [--message <text>] [--message-id <id>]\` - Create thread
- \`modelnet bot message thread list <botId> --target <channelId> [--json]\` - List threads
- \`modelnet bot message thread reply <botId> --thread-id <id> --message <text>\` - Reply to thread
- \`modelnet bot message channel list <botId> [--server-id <id>] [--filter <type>] [--json]\` - List channels
- \`modelnet bot message channel info <botId> --target <channelId> [--json]\` - Get channel info
- \`modelnet bot message member info <botId> --member-id <id> [--server-id <id>] [--json]\` - Get member info

## Tips

- Each platform requires specific credentials (token, app ID, secrets)
- Use \`modelnet bot connect\` to start a long-running bot connection
- Use \`modelnet bot message read\` with \`--json\` for batch message retrieval — ideal for processing large volumes of messages
- For step-by-step platform setup instructions, read the platform-specific reference under \`references/bot/\`: \`discord\`, \`telegram\`, \`slack\`, \`feishu\`, \`lark\`, \`qq\`, \`wechat\`
`;

export default content;
