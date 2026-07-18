const content = `# modelnet file - File Management

Manage uploaded files.

## Subcommands

- \`modelnet file list [--kb-id <id>] [-L <limit>]\` - List files (optionally filter by knowledge base)
- \`modelnet file view <id>\` - View file details
- \`modelnet file delete <ids...> [--yes]\` - Delete one or more files
- \`modelnet file recent [-L <limit>]\` - List recently accessed files

## Tips

- Files can be associated with knowledge bases
- Use \`modelnet kb upload\` to upload new files to a knowledge base
`;

export default content;
