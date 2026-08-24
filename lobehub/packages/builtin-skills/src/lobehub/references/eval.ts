const content = `# modelnet eval - Evaluation Workflow Management

Manage external evaluation workflows for testing agent quality.

## Subcommands

- \`modelnet eval run get --run-id <id>\` - Get run information
- \`modelnet eval run set-status --run-id <id> --status <completed|external>\` - Set run status
- \`modelnet eval dataset get --dataset-id <id>\` - Get dataset information
- \`modelnet eval run-topics list --run-id <id> [--only-external]\` - List topics in a run
- \`modelnet eval threads list --topic-id <id>\` - List threads by topic
- \`modelnet eval messages list --topic-id <id> [--thread-id <id>]\` - List messages
- \`modelnet eval test-cases count --dataset-id <id>\` - Count test cases
- \`modelnet eval run-topic report-result --run-id <id> --topic-id <id> --score <n>\` - Report result

## Tips

- Evaluation runs test agent responses against datasets
- Use \`report-result\` to submit scores for individual topics
`;

export default content;
