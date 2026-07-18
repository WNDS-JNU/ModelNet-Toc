const content = `# modelnet provider - AI Provider Management

Manage AI providers and their configurations.

## Subcommands

- \`modelnet provider list\` - List all providers
- \`modelnet provider view <id>\` - View provider details
- \`modelnet provider create --id <id> -n <name> [-s <source>] [--sdk-type <type>]\` - Create provider
- \`modelnet provider edit <id> [-n <name>] [-d <description>]\` - Update provider
- \`modelnet provider config <id> [--api-key <key>] [--base-url <url>] [--show]\` - Configure settings
- \`modelnet provider test <id> [-m <model>]\` - Test provider connectivity
- \`modelnet provider toggle <id> [--enable|--disable]\` - Enable/disable provider
- \`modelnet provider delete <id> [--yes]\` - Delete provider

## Tips

- Use \`modelnet provider config <id> --show\` to view current configuration
- \`modelnet provider test\` verifies API key and connectivity
`;

export default content;
