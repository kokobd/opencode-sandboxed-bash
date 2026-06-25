import {existsSync} from "fs"
import {tool, type Plugin, type ToolContext, type ToolResult} from "@opencode-ai/plugin"

// This plugin provides two shell tools that together replace the builtin bash tool:
//
//   - sandboxed-bash  — runs in a bwrap sandbox, WITHOUT user approval. No network,
//                        and writes are confined to the project directory (plus any
//                        configured extra writable directories). This is the default.
//   - privileged-bash — runs on the host with full authority (network + full
//                        filesystem). Gated by opencode's native permission prompt.
//
// To adopt this plan, disable the builtin bash tool in your opencode config so the
// model only sees these two:
//
//   {
//     "tools": { "bash": false },
//     "permission": { "privileged-bash": "ask" }
//   }
//
// `tools: { "bash": false }` adds a `bash` deny rule, which removes the builtin bash
// tool from the model's tool list. privileged-bash deliberately uses its OWN permission
// action ("privileged-bash") so that the bash deny rule does not also deny it.

interface BashArgs {
  command: string;
}

// Bound the output handed back to the model so a runaway command can't blow up the context.
// 64 KiB per stream is ~16k tokens, large enough for real output but far below the context window.
const MAX_CAPTURE_BYTES = 64 * 1024

// The permission action used to gate privileged-bash. Kept distinct from "bash" on
// purpose: disabling the builtin bash tool installs a `bash` deny rule (pattern "*"),
// and reusing that action here would make every privileged-bash call auto-denied.
const PRIVILEGED_PERMISSION = "privileged-bash"

// Shown when the builtin bash tool is invoked despite this plan. Disabling it via config
// (`tools: { "bash": false }`) removes it from the model's tool list entirely; this message
// is the belt-and-suspenders fallback for setups where that config wasn't applied, so the
// model is redirected to the two replacement tools rather than silently using host bash.
const BUILTIN_BASH_DENIED_MESSAGE =
  `The builtin bash tool is disabled in this project. Use 'sandboxed-bash' for shell commands by default — it runs WITHOUT approval, reads the whole filesystem, but has no network access and can only write to the project directory (plus any configured extra writable directories). Use 'privileged-bash' ONLY when the command genuinely needs network access or must write outside those directories (it runs on the host and is approval-gated). Re-issue your command with one of those two tools.`

const captureNotice = (stdoutTruncated: boolean, stderrTruncated: boolean): string | undefined => {
  const limit = `${MAX_CAPTURE_BYTES / 1024} KiB`
  if (stdoutTruncated && stderrTruncated) return `[stdout and stderr truncated to ${limit} each]`
  if (stdoutTruncated) return `[stdout truncated to ${limit}]`
  if (stderrTruncated) return `[stderr truncated to ${limit}]`
  return undefined
}

interface ShellResult {
  exitCode: number
  stdout: Buffer
  stderr: Buffer
}

// Turn a finished shell result into the bounded, model-facing output string. Shared by
// both tools so their output format stays identical.
const formatOutput = (result: ShellResult): string => {
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

  return `${body}\n\nCommand exited with code ${result.exitCode}.`
}

const plugin: Plugin = async (input, options) => {
  const bwrapPath = (options?.bwrapPath as string) ?? "bwrap"
  const extraWritableDirs = (options?.extraWritableDirs as string[]) ?? []

  return {
    // Hard-deny the builtin bash tool with an agent-friendly redirect. This is a fallback
    // for when the builtin bash tool has NOT been removed via config (`tools: { "bash": false }`);
    // when that config is present the tool never reaches the model and this hook never fires.
    "tool.execute.before": async (hookInput) => {
      if (hookInput.tool !== "bash") return
      throw new Error(BUILTIN_BASH_DENIED_MESSAGE)
    },
    tool: {
      "sandboxed-bash": tool({
        description: `Execute shell commands inside an isolated sandbox. This is the DEFAULT tool for running shell commands: prefer it over privileged-bash whenever a command needs neither network access nor writes outside the writable directories listed below, because it runs WITHOUT user approval.

Sandbox environment:
- Reads: the entire filesystem is readable, subject to normal user permissions — paths the current user cannot access (e.g. other users' home directories) stay off-limits.
- Writes: the filesystem is read-only EXCEPT the project directory${extraWritableDirs.length > 0 ? ` and these extra writable directories: ${extraWritableDirs.join(", ")}` : ""}. Writes there are persistent — they map to the real host directories and survive across invocations.
- Network: no Internet/network access (local Unix domain sockets on the filesystem, e.g. gpg-agent, still work).
- Blocked operations (network access, writes to read-only paths) fail with a non-zero exit status and an error message on stderr, both reflected in the tool output.

When to use privileged-bash instead: ONLY when a command genuinely needs network access or must write outside the writable directories above. privileged-bash runs on the host with full authority and is approval-gated, so reach for the sandbox first.

Do NOT escalate ordinary command failures to privileged-bash. Failing tests, a grep with no match, compile errors, and similar non-zero exits are real results, not sandbox limitations — switch tools only when the failure is clearly caused by the sandbox (network or read-only filesystem).`,
        args: {
          command: tool.schema.string(),
        },
        async execute(args: BashArgs, context: ToolContext): Promise<ToolResult> {
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

          return {
            output: formatOutput(result),
          }
        },
      }),
      "privileged-bash": tool({
        description: `Execute a shell command on the HOST with full authority: network access and read/write to the entire filesystem (subject to normal user permissions). Each invocation is gated by a user-approval prompt (unless the user has allow-listed the command).

Use this ONLY when a command genuinely needs something the sandbox cannot provide:
- network/Internet access, or
- writes outside sandboxed-bash's writable directories.

For everything else — including ordinary command failures like failing tests, an empty grep, or compile errors — use sandboxed-bash. Those failures are real results, not reasons to escalate. Do not use privileged-bash merely to retry a command that failed in the sandbox for a non-sandbox reason.`,
        args: {
          command: tool.schema.string(),
        },
        async execute(args: BashArgs, context: ToolContext): Promise<ToolResult> {
          // Gate on the user's approval via opencode's native permission system.
          // Resolves without prompting if a matching allow rule already exists (e.g.
          // the user previously chose "always allow"); rejects (throws) on denial,
          // which surfaces to the model as a tool error and leaves the command unrun.
          await context.ask({
            permission: PRIVILEGED_PERMISSION,
            patterns: [args.command],
            always: [args.command],
            metadata: {command: args.command},
          })

          const result = await input.$`bash -c ${args.command}`.cwd(context.directory).nothrow().quiet()

          return {
            output: formatOutput(result),
          }
        },
      }),
    },
  }
}

export default plugin
