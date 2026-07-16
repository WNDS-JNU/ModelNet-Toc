const content = `# modelnet doc - Document Management

Manage documents (text content that can be standalone or in knowledge bases).

## Subcommands

- \`modelnet doc list [-L <limit>] [--file-type <type>] [--source-type <type>]\` - List documents
- \`modelnet doc view <id>\` - View document content
- \`modelnet doc create -t <title> -b <body> [--kb <kbId>] [--parent <folderId>]\` - Create document
- \`modelnet doc batch-create <jsonFile>\` - Batch create documents from JSON file
- \`modelnet doc edit <id> [-t <title>] [-b <body>]\` - Edit document
- \`modelnet doc delete <ids...> [--yes]\` - Delete documents
- \`modelnet doc parse <fileId> [--with-pages]\` - Parse uploaded file into document
- \`modelnet doc link-topic <docId> <topicId>\` - Associate document with topic
- \`modelnet doc topic-docs <topicId> [--type <type>]\` - List documents for a topic

## Tips

- Use \`-F <filePath>\` instead of \`-b\` to read body content from a file
- \`modelnet doc parse\` extracts text from uploaded files (PDF, DOCX, etc.)
`;

export default content;
