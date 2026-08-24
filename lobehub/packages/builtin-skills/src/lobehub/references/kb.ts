const content = `# modelnet kb - Knowledge Base Management

Manage knowledge bases, folders, documents, and files.

## Subcommands

- \`modelnet kb list\` - List all knowledge bases
- \`modelnet kb view <id>\` - View KB with all items in tree structure
- \`modelnet kb create -n <name> [-d <description>]\` - Create a knowledge base
- \`modelnet kb edit <id> [-n <name>] [-d <description>]\` - Update KB metadata
- \`modelnet kb delete <id> [--remove-files] [--yes]\` - Delete a knowledge base
- \`modelnet kb add-files <kbId> --ids <fileId1,fileId2>\` - Add files to KB
- \`modelnet kb remove-files <kbId> --ids <fileId1,fileId2>\` - Remove files from KB
- \`modelnet kb mkdir <kbId> -n <name> [--parent <folderId>]\` - Create a folder
- \`modelnet kb create-doc <kbId> -t <title> -c <content> [--parent <folderId>]\` - Create a document in KB
- \`modelnet kb move <id> --parent <folderId> --type <file|doc>\` - Move file/document to folder
- \`modelnet kb upload <kbId> <filePath> [--parent <folderId>]\` - Upload file to KB

## Tips

- Use \`--json\` on any subcommand for structured output
- \`modelnet kb view\` shows a full tree of folders, files, and documents
- After uploading a file, use \`modelnet doc parse <fileId>\` to extract text content
`;

export default content;
