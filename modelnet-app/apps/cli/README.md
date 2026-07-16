# @modelnet/cli

ModelNet command-line interface.

## Local Development

| Task                                             | Command                    |
| ------------------------------------------------ | -------------------------- |
| Run in dev mode                                  | `bun run dev -- <command>` |
| Build the CLI                                    | `bun run build`            |
| Link `modelnet`/`lobe`/`lobehub` into your shell | `bun run cli:link`         |
| Remove the global link                           | `bun run cli:unlink`       |

- `bun run build` only generates `dist/index.js`.
- To make `modelnet` available in your shell, run `bun run cli:link`.
- After linking, if your shell still cannot find `modelnet`, run `rehash` in `zsh`.

## Custom Server URL

By default the CLI connects to `http://123.56.135.150`. To point it at a different server (e.g. a local instance):

| Method               | Command                                                         | Persistence                          |
| -------------------- | --------------------------------------------------------------- | ------------------------------------ |
| Environment variable | `LOBEHUB_SERVER=http://localhost:4000 bun run dev -- <command>` | Current command only                 |
| Login flag           | `modelnet login --server http://localhost:4000`                 | Saved to `~/.modelnet/settings.json` |

Priority: `LOBEHUB_SERVER` env var > `settings.json` > default official URL.

## Shell Completion

### Install completion for a linked CLI

| Shell  | Command                              |
| ------ | ------------------------------------ |
| `zsh`  | `source <(modelnet completion zsh)`  |
| `bash` | `source <(modelnet completion bash)` |

### Use completion during local development

| Shell  | Command                                      |
| ------ | -------------------------------------------- |
| `zsh`  | `source <(bun src/index.ts completion zsh)`  |
| `bash` | `source <(bun src/index.ts completion bash)` |

- Completion is context-aware. For example, `modelnet agent <Tab>` shows agent subcommands instead of top-level commands.
- If you update completion logic locally, re-run the corresponding `source <(...)` command to reload it in the current shell session.
- Completion only registers shell functions. It does not install the `modelnet` binary by itself.

## Quick Check

```bash
which modelnet
modelnet --help
modelnet agent <TAB>
```
