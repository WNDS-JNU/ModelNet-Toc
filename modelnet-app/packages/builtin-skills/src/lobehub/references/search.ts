const content = `# modelnet search - Search Resources

Search local resources or the web.

## Subcommands

- \`modelnet search -q <query> [-t <type>] [-L <limit>]\` - Search local resources
- \`modelnet search -q <query> -w [-e <engines>] [-c <categories>]\` - Search the web
- \`modelnet search view <target>\` - View search result details or crawl a URL

## Search Types (local)

agent, topic, file, folder, message, page, memory, mcp, plugin, communityAgent, knowledgeBase

## Tips

- Use \`-w\` flag to perform web search instead of local search
- \`modelnet search view <url>\` can crawl and extract content from web pages
- Web search supports engine and category filters
`;

export default content;
