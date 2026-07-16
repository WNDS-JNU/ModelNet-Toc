# modelnet task - Complete Command Reference

## Core Commands

- `modelnet task list [--status <status>] [--root] [--parent <id>] [--agent <id>] [-L <limit>] [--tree]` - List tasks
  - `--status`: pending, running, paused, completed, failed, canceled
  - `--root`: Only root tasks (no parent)
  - `--tree`: Display as tree structure
- `modelnet task view <id>` - View task details (instruction, workspace, activities)
- `modelnet task create -i <instruction> [-n <name>] [--agent <id>] [--parent <id>] [--priority <0-4>]` - Create task
  - Priority: 0=none, 1=urgent, 2=high, 3=normal, 4=low
- `modelnet task edit <id> [-n <name>] [-i <instruction>] [--status <status>] [--priority <0-4>] [--agent <id>]` - Update task
- `modelnet task delete <id> [--yes]` - Delete task
- `modelnet task clear [--yes]` - Delete all tasks
- `modelnet task tree <id>` - Show subtask tree with dependencies

## Lifecycle Commands

- `modelnet task start <id> [--no-run] [-p <prompt>] [-f] [-v]` - Start task (pending → running)
  - `--no-run`: Only update status, skip agent execution
  - `-f, --follow`: Follow agent output in real-time
  - `-v, --verbose`: Show detailed tool call info
- `modelnet task run <id> [-p <prompt>] [-c <topicId>] [-f] [--topics <n>] [--delay <s>]` - Run/re-run agent execution
  - `-c, --continue`: Continue on existing topic
  - `--topics <n>`: Run N topics in sequence
- `modelnet task pause <id>` - Pause running task
- `modelnet task resume <id>` - Resume paused task
- `modelnet task complete <id>` - Mark as completed
- `modelnet task cancel <id>` - Cancel task
- `modelnet task comment <id> -m <message>` - Add comment
- `modelnet task sort <parentId> <id1> <id2> ...` - Reorder subtasks
- `modelnet task heartbeat <id>` - Send manual heartbeat
- `modelnet task watchdog` - Detect and fail stuck tasks

## Checkpoint Commands

- `modelnet task checkpoint view <id>` - View checkpoint config
- `modelnet task checkpoint set <id> [--on-agent-request <bool>] [--topic-before <bool>] [--topic-after <bool>] [--before <ids>] [--after <ids>]` - Configure checkpoints
  - `--on-agent-request`: Allow agent to request review
  - `--topic-before/after`: Pause before/after each topic
  - `--before/after <ids>`: Pause before/after specific subtask identifiers

## Review Commands (LLM-as-Judge)

- `modelnet task review view <id>` - View review config
- `modelnet task review set <id> [--model <model>] [--provider <provider>] [--max-iterations <n>] [--no-auto-retry] [--recursive]` - Configure review
- `modelnet task review criteria list <id>` - List review rubrics
- `modelnet task review criteria add <id> -n <name> [--type <type>] [-t <threshold>] [-d <description>] [--value <value>] [--pattern <pattern>] [-w <weight>] [--recursive]` - Add rubric
  - Types: llm-rubric, contains, equals, starts-with, ends-with, regex
  - Threshold: 0-100
- `modelnet task review criteria rm <id> -n <name> [--recursive]` - Remove rubric
- `modelnet task review run <id> --content <text>` - Manually run review

## Dependency Commands

- `modelnet task dep add <taskId> <dependsOnId> [--type <blocks|relates>]` - Add dependency
- `modelnet task dep rm <taskId> <dependsOnId>` - Remove dependency
- `modelnet task dep list <taskId>` - List dependencies

## Topic Commands

- `modelnet task topic list <id>` - List topics for task
- `modelnet task topic view <id> <topicId>` - View topic messages (topicId can be seq number like "1")
- `modelnet task topic cancel <topicId>` - Cancel running topic and pause task
- `modelnet task topic delete <topicId> [--yes]` - Delete topic and messages

## Document Commands (Workspace)

- `modelnet task doc create <id> -t <title> [-b <content>] [--parent <docId>] [--folder]` - Create and pin document
- `modelnet task doc pin <id> <documentId>` - Pin existing document
- `modelnet task doc unpin <id> <documentId>` - Unpin document
- `modelnet task doc mv <id> <documentId> <folder>` - Move document into folder (auto-creates folder)

## Tips

- All commands support `--json [fields]` for structured output
- Task identifiers use format like TASK-1, TASK-2, etc.
- Use `modelnet task tree` to visualize full task hierarchy before planning work
- Use `modelnet task comment` to log progress — comments appear in task activities
- Documents in workspace are accessible to the agent during execution
