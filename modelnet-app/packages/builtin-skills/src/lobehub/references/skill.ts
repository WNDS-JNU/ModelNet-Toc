const content = `# modelnet skill - Skill Management

Manage agent skills (reusable prompt+resource bundles).

## Subcommands

- \`modelnet skill list [--source <builtin|market|user>]\` - List skills
- \`modelnet skill view <id>\` - View skill details
- \`modelnet skill create -n <name> -d <description> -c <content>\` - Create user skill
- \`modelnet skill edit <id> [-c <content>] [-n <name>] [-d <description>]\` - Update skill
- \`modelnet skill delete <id> [--yes]\` - Delete skill
- \`modelnet skill search <query>\` - Search skills
- \`modelnet skill install <source> [--branch <b>]\` - Install from GitHub/URL/marketplace
- \`modelnet skill resources <id>\` - List skill resource files
- \`modelnet skill read-resource <id> <path>\` - Read a skill resource file

## Tips

- Skills can be installed from GitHub repos, URLs, or the marketplace
- Use \`resources\` and \`read-resource\` to inspect skill reference files
`;

export default content;
