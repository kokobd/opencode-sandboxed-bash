import {existsSync} from "fs"
import {tool, type Plugin, type ToolContext, type ToolResult} from "@opencode-ai/plugin"

interface SandboxedBashArgs {
  command: string;
}

const plugin: Plugin = async (input, options) => {
  const bwrapPath = (options?.bwrapPath as string) ?? "bwrap"
  const extraWritableDirs = (options?.extraWritableDirs as string[]) ?? []

  return {
    tool: {
      "sandboxed-bash": tool({
        description: `Execute shell commands inside an isolated sandbox. Prefer this over the builtin bash tool whenever the command does not need network access, since it runs without user approval.

Sandbox constraints:
- No Internet/network access (Unix domain sockets on the filesystem, e.g. gpg-agent, are still accessible).
- Filesystem is read-only except for the project directory and any configured extra directories.
- Write access limited to the project directory and its children.

Use the builtin bash tool instead when the command needs to download files, reach a remote API, or write outside the project directory.`,
        args: {
          command: tool.schema.string(),
        },
        async execute(args: SandboxedBashArgs, context: ToolContext): Promise<ToolResult> {
          const writableDirs: string[] = [context.directory, ...extraWritableDirs.filter(existsSync)]
          const bindArgs: string[] = writableDirs.flatMap(dir => ["--bind", dir, dir])

          const result = await input.$`${bwrapPath}
            --ro-bind / /
            --dev /dev
            --proc /proc
            --ro-bind /sys /sys
            --tmpfs /tmp
            ${bindArgs}
            --unshare-net
            --die-with-parent
            --chdir ${context.directory}
            -- bash -c ${args.command}`.nothrow()

          return {
            output: result.stdout.toString(),
            metadata: {
              exitCode: result.exitCode,
              stderr: result.stderr.toString()
            },
          }
        },
      }),
    },
  }
}

export default plugin
