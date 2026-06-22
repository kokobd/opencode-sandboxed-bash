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

// How many of the most recent messages we scan for a prior sandboxed-bash attempt.
const SANDBOX_LOOKBACK_MESSAGES = 10

const plugin: Plugin = async (input, options) => {
  const bwrapPath = (options?.bwrapPath as string) ?? "bwrap"
  const extraWritableDirs = (options?.extraWritableDirs as string[]) ?? []

  return {
    // Gate the builtin bash tool: before it runs (and before the user is asked to
    // approve it), require that the exact same command was attempted in the sandbox
    // within the recent chat history. This nudges the model to prefer sandboxed-bash
    // and only fall back to the approval-gated builtin bash when the sandbox can't
    // run the command (e.g. it needs network access).
    "tool.execute.before": async (hookInput, hookOutput) => {
      if (hookInput.tool !== "bash") return

      const command = hookOutput.args?.command
      if (typeof command !== "string") return
      const target = command.trim()

      const response = await input.client.session.messages({
        path: {id: hookInput.sessionID},
      })
      const messages = response.data ?? []
      const recent = messages.slice(-SANDBOX_LOOKBACK_MESSAGES)

      const triedInSandbox = recent.some(message =>
        message.parts.some(part => {
          if (part.type !== "tool" || part.tool !== "sandboxed-bash") return false
          const tried = part.state.input?.command
          return typeof tried === "string" && tried.trim() === target
        }),
      )

      if (!triedInSandbox) {
        throw new Error(
          "The builtin bash tool is approval-gated and may only run a command that was first attempted verbatim with the sandboxed-bash tool and shown unable to run there (e.g. it needs network access). The command strings must match exactly, whitespace included. If this is a retry after a sandbox failure, re-issue the identical command you ran in sandboxed-bash. Otherwise, run it in sandboxed-bash first — prefer it whenever the command does not need network or out-of-project writes.",
        )
      }
    },
    tool: {
      "sandboxed-bash": tool({
        description: `Execute shell commands inside an isolated sandbox. Prefer this over the builtin bash tool whenever the command does not need network access, since it runs without user approval.

Sandbox constraints:
- No Internet/network access (Unix domain sockets on the filesystem, e.g. gpg-agent, are still accessible).
- Filesystem is read-only except for the project directory${extraWritableDirs.length > 0 ? ` and these extra writable directories: ${extraWritableDirs.join(", ")}` : ""}.
- Writes to the writable directories are persistent (they map to the real host directories) and survive across invocations.
- Operations that the sandbox blocks (network access, writes to read-only paths) fail with a non-zero exit status and an error message on stderr, both reflected in the tool output.

When a command fails because of a sandbox restriction (it needs network access, or it must write to a read-only path outside the project / extra writable dirs), retry the EXACT same command, character for character, with the builtin bash tool. The builtin bash tool is gated: it will only run a command that was first attempted verbatim here, so do not edit, reformat, or re-quote the command when you retry it — any change makes the builtin bash call get rejected.

Do NOT escalate ordinary command failures to the builtin bash tool. Failing tests, a grep with no match, compile errors, and similar non-zero exits are real results, not sandbox limitations — only retry in builtin bash when the failure is clearly caused by the sandbox (network or read-only filesystem).`,
        args: {
          command: tool.schema.string(),
        },
        async execute(args: SandboxedBashArgs, context: ToolContext): Promise<ToolResult> {
          const writableDirs: string[] = [context.directory, ...extraWritableDirs.filter(existsSync)]
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
