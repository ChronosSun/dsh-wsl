// Prompt section: tell the model it is in Linux, and how to translate the
// Windows-shaped working directory it is still shown.
//
// A stable system section (not per-turn context) so the cached prefix is not
// perturbed; the text is static, so it never invalidates mid-session.
export const name = 'dsh-wsl/prompt'
export const inject = ['systemPrompt']

export function apply(ctx, config = {}) {
  const distro = config.distro ? ` (distribution: ${config.distro})` : ''
  const text = [
    '# Execution environment',
    `This session executes inside a WSL distribution${distro} on the user's machine, so the execution world is **Linux, not Windows**.`,
    '',
    '- **Every tool takes Linux paths.** `Current working directory` is a Linux path such as `/home/me/proj`. If a Windows view shows the same directory as `\\\\wsl.localhost\\<distro>\\...`, the Linux equivalent is that path with the prefix removed and backslashes turned into slashes; always use the Linux form in tool calls and in code you write.',
    '- Windows drives are mounted at `/mnt/<drive>`, so `C:\\Users\\me` is `/mnt/c/Users/me`.',
    '- `bash` runs `/bin/bash` inside the distribution with a PATH that contains no `/mnt/*` entries, so Windows binaries are deliberately unreachable; use the distribution\'s own `node`, `npm`, `git`, `python3`.',
    '- `ssh`, `scp`, `rsync` and `curl` are the distribution\'s own binaries; keys and `~/.ssh/config` are the distribution user\'s. The Agent has no TTY, so use key-based auth (`ssh -o BatchMode=yes host \'command\'`) or `ControlMaster` instead of an interactive password prompt; use the sidebar terminal for interactive logins.',
    '- `read`, `write`, `edit`, `glob` and `grep` operate directly on the Linux filesystem. `glob` and `grep` require an explicit `path`.',
    '- `web_fetch` / `web_search` run on the host but share the network. A service started inside the distribution is reachable at `http://localhost:<port>` (WSL2 localhost forwarding); use `curl` in `bash` when it must run from Linux or through an SSH tunnel.',
    '- Quote shell variables (`"$VAR"`): this Harness build parses some commands twice, and an unquoted value containing spaces or parentheses can break the command.',
  ].join('\n')

  return ctx.systemPrompt.section({ name: 'wsl-world', order: 820, text })
}
