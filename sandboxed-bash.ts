import {existsSync} from "fs"
import {tool, type Plugin, type ToolContext, type ToolResult} from "@opencode-ai/plugin"

interface SandboxedBashArgs {
  command: string;
}

// Bound the output handed back to the model so a runaway command can't blow up the context.
// 64 KiB per stream is ~16k tokens, large enough for real output but far below the context window.
const MAX_CAPTURE_BYTES = 64 * 1024

const captureNotice = (stdoutTruncated: boolean, stderrTruncated: boolean): string | undefined => {
  const limit = `${MAX_CAPTURE_BYTES / 1024} KiB`
  if (stdoutTruncated && stderrTruncated) return `[stdout and stderr truncated to ${limit} each]`
  if (stdoutTruncated) return `[stdout truncated to ${limit}]`
  if (stderrTruncated) return `[stderr truncated to ${limit}]`
  return undefined
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
- Filesystem is read-only except for the project directory, any configured extra directories, and /tmp.
- Writes to the project directory and /tmp are persistent (they map to the real host directories) and survive across invocations.
- Operations that the sandbox blocks (network access, writes to read-only paths) fail with a non-zero exit status and an error message on stderr, both reflected in the tool output.

Use the builtin bash tool instead when the command needs to download files, reach a remote API, or write a file that must persist outside the project directory.`,
        args: {
          command: tool.schema.string(),
        },
        async execute(args: SandboxedBashArgs, context: ToolContext): Promise<ToolResult> {
          const writableDirs: string[] = ["/tmp", context.directory, ...extraWritableDirs.filter(existsSync)]
          const bindArgs: string[] = writableDirs.flatMap(dir => ["--bind", dir, dir])

          const bwrapArgs: string[] = [
            "--ro-bind", "/", "/",
            "--dev", "/dev",
            "--proc", "/proc",
            "--ro-bind", "/sys", "/sys",
            ...bindArgs,
            "--unshare-net",
            "--die-with-parent",
            "--chdir", context.directory,
            "--", "bash", "-c", args.command,
          ]

          const result = await input.$`${bwrapPath} ${bwrapArgs}`.nothrow().quiet()

          const exitCode = result.exitCode

          const stdoutTruncated = result.stdout.byteLength > MAX_CAPTURE_BYTES
          const stderrTruncated = result.stderr.byteLength > MAX_CAPTURE_BYTES
          const stdout = (stdoutTruncated ? result.stdout.subarray(0, MAX_CAPTURE_BYTES) : result.stdout).toString()
          const stderr = (stderrTruncated ? result.stderr.subarray(0, MAX_CAPTURE_BYTES) : result.stderr).toString()

          const compact = stdout && stderr
            ? `${stdout}\n\nstderr:\n${stderr}`
            : stderr
              ? `stderr:\n${stderr}`
              : stdout || "(no output)"

          const notice = captureNotice(stdoutTruncated, stderrTruncated)
          const body = notice ? `${compact}\n\n${notice}` : compact

          return {
            output: `${body}\n\nCommand exited with code ${exitCode}.`,
          }
        },
      }),
    },
  }
}

export default plugin
