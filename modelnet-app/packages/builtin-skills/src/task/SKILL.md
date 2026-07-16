\<task_skill_guides>
You are executing a task within the ModelNet task system. Use the `modelnet task` CLI via `runCommand` to manage your task and related resources.

# Task Lifecycle

| Command                               | Description                                           |
| ------------------------------------- | ----------------------------------------------------- |
| `modelnet task view <id>`             | View task details, instruction, workspace, activities |
| `modelnet task edit <id>`             | Update task name, instruction, status, priority       |
| `modelnet task complete <id>`         | Mark task as completed                                |
| `modelnet task comment <id> -m "..."` | Add a progress comment                                |
| `modelnet task tree <id>`             | View subtask tree with dependencies                   |

# Working with Subtasks

| Command                                         | Description       |
| ----------------------------------------------- | ----------------- |
| `modelnet task create -i "..." --parent <id>`   | Create a subtask  |
| `modelnet task list --parent <id>`              | List subtasks     |
| `modelnet task sort <parentId> <id1> <id2> ...` | Reorder subtasks  |
| `modelnet task dep add <id> <dependsOnId>`      | Add dependency    |
| `modelnet task dep rm <id> <dependsOnId>`       | Remove dependency |

# Task Workspace (Documents)

| Command                                                 | Description               |
| ------------------------------------------------------- | ------------------------- |
| `modelnet task doc create <id> -t "title" -b "content"` | Create and pin a document |
| `modelnet task doc pin <id> <docId>`                    | Pin existing document     |
| `modelnet task doc unpin <id> <docId>`                  | Unpin document            |

# Task Topics (Conversations)

| Command                                   | Description              |
| ----------------------------------------- | ------------------------ |
| `modelnet task topic list <id>`           | List conversation topics |
| `modelnet task topic view <id> <topicId>` | View topic messages      |

# Usage Pattern

1. Read the reference file for detailed command options: `readReference('references/commands')`
2. Run commands via `runCommand` — the `modelnet` prefix is automatically handled
3. Use `--json` flag on any command for structured output
4. Use `modelnet task <subcommand> --help` for full command-line help

# Task Execution Guidelines

- **Check your task first**: Use `modelnet task view` to understand the full instruction and context
- **Use workspace documents**: Store outputs and deliverables as task documents
- **Report progress**: Use `modelnet task comment` to log key milestones
- **Respect dependencies**: Check `modelnet task tree` to understand task ordering
- **Complete when done**: Use `modelnet task complete` when all deliverables are ready
  \</task_skill_guides>
