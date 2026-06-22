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

// How many of the most recent messages we scan for a prior attempt of the same
// command (in either sandboxed-bash or builtin bash). A window rather than just
// the last message is deliberate: the model may try the command in the sandbox,
// do a few unrelated explorations, then fall back to builtin bash — and that
// fallback should pass without re-triggering the speed-bump.
const SANDBOX_LOOKBACK_MESSAGES = 10

const plugin: Plugin = async (input, options) => {
  const bwrapPath = (options?.bwrapPath as string) ?? "bwrap"
  const extraWritableDirs = (options?.extraWritableDirs as string[]) ?? []

  return {
    // Speed-bump the builtin bash tool: before it runs (and before the user is
    // asked to approve it), allow the command only if the exact same command was
    // already attempted in the recent chat history — in either sandboxed-bash or
    // builtin bash. The first attempt of any new command is auto-rejected to make
    // the model pause and reconsider whether the sandbox would do; a verbatim
    // retry then passes (the rejected attempt is now "already tried in bash").
    // This nudges toward sandboxed-bash without hard-blocking legitimate fallback
    // to the approval-gated builtin bash (e.g. when the command needs network).
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

      const triedBefore = recent.some(message =>
        message.parts.some(part => {
          if (part.type !== "tool") return false
          if (part.tool !== "sandboxed-bash" && part.tool !== "bash") return false
          // Exclude the in-flight call itself: its part already exists in the
          // session (created when the model emitted the tool call, before this
          // hook runs), so without this guard the command would always
          // self-match and the gate would never fire.
          if (part.callID === hookInput.callID) return false
          const tried = part.state.input?.command
          return typeof tried === "string" && tried.trim() === target
        }),
      )

      if (!triedBefore) {
        throw new Error(
          "Automatic rejection — nothing is wrong with the command itself, no edits needed. This exact command has not been attempted yet with either the sandboxed-bash tool or the builtin bash tool. Pause and reconsider which tool fits: prefer sandboxed-bash (runs without approval; reads the whole filesystem; but has no network access and can only write to the project directory and any configured extra writable directories), and reserve the builtin bash tool for commands that genuinely need network access or must write outside those directories. If you still want the builtin bash tool, re-issue the EXACT same command verbatim (whitespace included) and it will be allowed through.",
        )
      }
    },
    tool: {
      "sandboxed-bash": tool({
        description: `Execute shell commands inside an isolated sandbox. This is the DEFAULT tool for running shell commands: prefer it over the builtin bash tool whenever a command needs neither network access nor writes outside the writable directories listed below, because it runs WITHOUT user approval.

Sandbox environment:
- Reads: the entire filesystem is readable, subject to normal user permissions — paths the current user cannot access (e.g. other users' home directories) stay off-limits.
- Writes: the filesystem is read-only EXCEPT the project directory${extraWritableDirs.length > 0 ? ` and these extra writable directories: ${extraWritableDirs.join(", ")}` : ""}. Writes there are persistent — they map to the real host directories and survive across invocations.
- Network: no Internet/network access (local Unix domain sockets on the filesystem, e.g. gpg-agent, still work).
- Blocked operations (network access, writes to read-only paths) fail with a non-zero exit status and an error message on stderr, both reflected in the tool output.

When to fall back to the builtin bash tool: only when a command genuinely needs network access or must write outside the writable directories. The builtin bash tool is approval-gated, AND its FIRST attempt of any given command is automatically rejected to make you reconsider the tool choice. To get through, re-issue the EXACT same command verbatim (character for character, whitespace included) — do not edit, reformat, or re-quote it. Because the command was already attempted here in sandboxed-bash, the verbatim builtin-bash retry passes on the first try with no extra rejection.

Do NOT escalate ordinary command failures to the builtin bash tool. Failing tests, a grep with no match, compile errors, and similar non-zero exits are real results, not sandbox limitations — fall back only when the failure is clearly caused by the sandbox (network or read-only filesystem). The verbatim-retry mechanism is a deliberate speed-bump for that fallback, not a way to routinely run commands in builtin bash; reach for the sandbox first.`,
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
