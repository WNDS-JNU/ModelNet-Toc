const content = `# modelnet plugin - Plugin Management

Manage installed plugins (external tool integrations).

## Subcommands

- \`modelnet plugin list\` - List installed plugins
- \`modelnet plugin install -i <identifier> [--manifest <url>] [--type <type>] [--settings <json>]\` - Install plugin
- \`modelnet plugin uninstall <id> [--yes]\` - Uninstall plugin
- \`modelnet plugin update <id> [--manifest <url>] [--settings <json>]\` - Update plugin

## Tips

- Plugins extend agent capabilities with external tools
- Use \`--settings\` to pass JSON configuration during install/update
`;

export default content;
