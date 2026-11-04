# macOS

Mina runs on macOS 27 "Golden Gate", version 27.2 or later, on Apple silicon. It is tested on macOS 27.2 (MacBook Pro, M1 Pro). On macOS, Mina has the same sandbox as on Linux: each command of the agent runs in a new, empty sandbox that contains only your project and the folders that you add.
The mechanism is different: Seatbelt profiles and launchd jobs replace bubblewrap and the systemd scope.
For the guarantees themselves, read [the sandbox boundary](sandbox.md). This document tells how macOS gives them, and where macOS cannot give exactly the same behavior.

- [Requirements](#requirements)
- [Install](#install)
- [How it works](#how-it-works)
- [The same as on Linux](#the-same-as-on-linux)
- [Differences from Linux](#differences-from-linux)
- [Privacy permissions](#privacy-permissions)
- [Troubleshooting](#troubleshooting)
- [Tests](#tests)
- [Notes for macOS 27](#notes-for-macos-27)
- [Probe results](#probe-results)
- [Sources](#sources)

## Requirements

- macOS 27.2 or later on Apple silicon. macOS 27.0 and 27.2 fix several Sandbox escapes.
- The Command Line Tools: `xcode-select --install`. Mina builds two small native helpers with them.
- Node.js 24 or newer, for example from Homebrew: `brew install node`.
- [uv](https://docs.astral.sh/uv/), for the literature tools: `brew install uv`.
- An account for a model provider, for example a Claude subscription with Claude Code.

You do not need an administrator account, a Developer ID, or a separate macOS user.

## Install

1. Clone the repository and install the pinned packages:

   ```bash
   git clone https://github.com/mratan/mina.git && cd mina
   npm ci
   ```

2. Build the native helpers:

   ```bash
   npm run macos:helpers
   ```

   This builds `build/macos/mina-instance` and `build/macos/bin/mina-ps` (`ps`, `pgrep`, and `pkill` for the agent's commands).
   Run it again after an update that changes `sandbox/macos/*.c`. If the helpers are out of date, `mina` refuses to start and tells you to run this command.

3. Install the literature servers:

   ```bash
   npm run literature:install
   ```

   On macOS, the installer puts a Python 3.14 in the install folder, because `/usr/bin/python3` is too old. It uses the Node.js on your `PATH`.

4. Put `mina` on your `PATH`:

   ```bash
   mkdir -p ~/.local/bin && ln -s "$PWD/bin/mina.mjs" ~/.local/bin/mina
   ```

5. Sign in to Claude Code (`claude auth login --claudeai`), or to another provider. See [a first session](../README.md#a-first-session).

## How it works

| Part | Linux | macOS |
|---|---|---|
| The instance | `systemd-run --scope`: one scope for each instance | One launchd job for each instance (`com.mina.instance.ID`), with its own resource coalition. No process can leave its coalition. |
| The terminal | The scope keeps the terminal | `mina` passes its terminal (the file descriptors 0 to 2) to the instance job. Pi uses your real terminal. `mina` passes on window size changes, Ctrl+C, Ctrl+Z, `fg`, and a closed terminal, and it returns the exit status of Pi. |
| The outer layer (Pi) | bwrap: read-only root, private `/tmp` and runtime folder, writes only to the roots of the launch | A Seatbelt profile with the same rules: Pi reads the host; it writes only to the roots of the launch and its own temporary folder; `/private/tmp` and your temporary folder are hidden; only the sockets of Mina, the broker, and the name service are reachable; no clipboard. |
| A worker (each command and file operation) | A new bwrap with its own PID, network, and mount namespaces | A new launchd job (`com.mina.call.ID.N`) with its own coalition and a deny-by-default Seatbelt profile. When the main process of the call exits, every other process of the call stops, also a detached one. |
| Who starts the workers | Pi, with bwrap | A process in a Seatbelt sandbox cannot start a second sandbox. Thus, Pi sends each request to the supervisor of the instance (`sandbox/macos/supervisor.mjs`). The supervisor builds the profile, refuses a write root that is not a root of the launch, and starts the call. |
| Network of a worker | Its own loopback; a bridge to the egress proxy | Only one TCP port on localhost: the egress proxy of the instance. The proxy needs the token of the instance. |
| Limits | cgroup: MemoryMax, CPUQuota, TasksMax, RuntimeMaxSec | Watchdogs on the coalitions of the instance (see [differences](#differences-from-linux)) |
| Protected checks | A snapshot mounted over `.mina/checks` | The accepted bytes run in place; see [differences](#differences-from-linux) |
| The host broker | A systemd user service | A LaunchAgent; see [the host profile](host-profile.md) |

The native helper `mina-instance` (`sandbox/macos/mina-instance.c`) is the program of each launchd job. It starts its child and stays its parent, so macOS gives the [privacy permissions](#privacy-permissions) to Mina, not to Node or to your shell.

## The same as on Linux

- A worker sees only the project, the folders that you declare, Mina's skills, and read-only system software (`/usr`, `/System`, the Command Line Tools, Xcode, Homebrew, `/usr/local`). Other files are refused.
- Credentials stay hidden, also inside declared folders.
- A worker has no DNS, cannot reach a host loopback service or the LAN, and reaches the internet only through the egress proxy. `offline` gives no network.
- A worker cannot signal or inspect a process outside its call. `ps`, `pgrep`, and `pkill` show only the processes of the call.
- When a call ends, all its processes stop: background processes, `setsid`, and double forks too. A timeout or an abort stops them too.
- A worker cannot use `open`, AppleEvents, `launchctl`, the pasteboard, the Keychain, `crontab`, or the GPU.
- Read grants during a session apply from the next call.
- `mina status` and `mina stop` work as on Linux. `mina stop` verifies that no process of the instance remains.
- The literature servers and the PDF converter have their own sandboxes, with the same roots as on Linux. The PDF converter has no network and a kernel memory bound.

## Differences from Linux

Seatbelt has no mount, PID, or network namespaces. Where macOS cannot give the Linux behavior, Mina keeps the security property and accepts the functional difference:

- **No private loopback.** On Linux, a server that a command starts can listen on its private loopback. Seatbelt cannot limit a listening socket to loopback (a rule for `localhost` also lets a server bind `0.0.0.0`, and the LAN can connect), and an outgoing rule for `localhost` would also reach your own local services. Thus, a worker cannot listen on a port. A test server inside a command, or a Jupyter kernel, fails.
- **No private `/tmp`.** Seatbelt cannot map a path to another path. Each call has its own `TMPDIR`, which is empty at the start of the call and removed at its end. Most tools use `TMPDIR`. A command that writes to `/tmp/...` directly gets "Operation not permitted". One exception exists: Apple `diff` writes a pipe input to `/private/tmp/diff.*`, so `diff <(...)` works.
- **"Operation not permitted" instead of "No such file or directory".** A path outside the sandbox exists, but the worker cannot open it. A hidden folder is refused; on Linux it is an empty folder.
- **Real paths.** `HOME` of a worker is a private folder of the instance (`~/.local/state/mina/instances/ID.home`), not `/home/mina`. Retained outputs are at their real path, not at `/run/mina-outputs`.
- **Limits are emulated.** The supervisor samples the processes of the instance four times a second:
  - memory: above the limit, it kills the largest process, as the OOM killer of a cgroup does;
  - CPU: above the quota, all processes pause for the excess time;
  - processes: above the limit, the newest processes are killed (on Linux, `fork` fails for them);
  - the deadline: the instance stops, as on Linux.

  A short peak inside one sampling interval can pass. The memory bound of the PDF converter is enforced by the kernel (a jetsam limit), because macOS does not lower `RLIMIT_AS`.
- **Protected checks.** On Linux, a protected check runs from a snapshot that is mounted over `.mina/checks`, in a pinned view of the project. On macOS:
  - Before the run, the supervisor verifies the accepted hashes. If the project's copy differs, it puts the accepted bytes in place for the run and restores the project's copy after it.
  - During the run, no worker can change `.mina/checks` or rename it or a parent folder. On Linux, a concurrent rename succeeds and the pinned checker does not see it; macOS cannot pin the paths, so the rename is refused while a check runs.
  - After the run, the supervisor verifies the hashes again, and moves new top-level files of the project to the staging folder of the check (on Linux they are created there).
- **Apple's developer tools.** `/usr/bin/git`, `python3`, `make`, and `clang` are xcrun shims that write a cache that a worker must not change. Thus, the real tools of the active developer folder come first in `PATH`, and `SDKROOT` is set. The developer folder's system git configuration (`credential.helper=osxkeychain`) is not read, as a Linux worker reads no `/etc/gitconfig`.
- **`ps`, `pgrep`, and `pkill`** are Mina's own small programs (`sandbox/macos/mina-ps.c`). They support the common options. `/bin/ps` and `top` cannot run in a Seatbelt sandbox.
- **A call costs more.** Each call is a launchd job: about 75 ms for a short command, compared with a few milliseconds for bwrap.

## Privacy permissions

macOS protects some folders (`~/Documents`, `~/Desktop`, `~/Downloads`, iCloud Drive) with privacy permissions. On macOS a permission belongs to a program, not to a session.

- A Mina instance does not get the permissions of Terminal. When a project is in a protected folder, macOS asks once: "mina-instance would like to access files in your Documents folder". Allow it.
- The permission belongs to `build/macos/mina-instance` in your checkout. It covers the instances and the host broker with its workloads, which start through it too. Other Node and Python programs and other launchd jobs do not get it. The sandbox still limits each session to its project.
- macOS keeps the permission by the path and the exact binary. A rebuild of `mina-instance` (`npm run macos:helpers` after a change to its source) asks again.
- To remove the permission: System Settings → Privacy & Security → Files & Folders.

## Troubleshooting

- **"the macOS helper is not built" or "out of date":** run `npm run macos:helpers`.
- **"Operation not permitted" in the agent's commands:** the path is outside the sandbox. Add it with `--sandbox-read` or `--sandbox-write`, or let the agent ask with `mina_sandbox_request`.
- **A project in `~/Documents` fails without a prompt:** a permission was denied before. Allow `mina-instance` in System Settings → Privacy & Security → Files & Folders.
- **The Command Line Tools are missing:** `xcode-select --install`.
- **Diagnostics:** `MINA_SUPERVISOR_DEBUG=/tmp/mina-supervisor.log mina ...` writes a log of the calls and the limits.

## Tests

On a Mac, in the checkout:

```bash
npm run macos:helpers
npm test                       # the whole suite; the tests of real workers run through the macOS sandbox
python3 test/e2e/terminal.py   # the terminal UI: a prompt, Ctrl+Z, fg, /quit
python3 host/test_hostd.py     # the host broker
```

The macOS tests are `test/macos-*.test.mjs` (the profiles, the supervisor, the instance and its limits) and the macOS cases in `literature/test/` (the PDF converter and the literature servers). They are skipped on Linux, as the Linux-only tests are skipped on macOS.

## Notes for macOS 27

These items come from Apple's release notes, from reports of other projects, and from the probe.

- `sandbox-exec` is deprecated, but it is present and works on 27.2. Apple has not announced a removal.
- `PATH` contains `/pkg/env/global/bin`. When a `PATH` folder is denied, Node's `spawn("git")` fails with `EPERM`. Mina gives a worker only the `PATH` folders that it can read.
- Under a deny-default profile, a child can hang in a Mach lookup of `notification_center` or `logd` (FB25399545). The profiles allow both services and do not log denials.
- launchd does not load a property list that has the quarantine attribute.
- macOS 27 kills binaries with an invalid ad-hoc signature. `npm run macos:helpers` verifies each helper with `codesign -v --strict`.
- Rosetta is not installed again after the upgrade. All runtimes and helpers must be arm64.
- `/bin/bash` is still version 3.2.

## Probe results

`scripts/macos-probe.py` tested the risky parts of the design before the port was built. Machine: MacBook Pro M1 Pro, macOS 27.2 (26B123).

- Full run, 2026-11-04: 106 PASS, 1 FAIL, 0 ERROR. The FAIL is `diff <(…)` under a profile without exceptions; the `diff.*` exception corrects it.
- **launchd and coalitions:** a job gets a fresh coalition; a double-forked `setsid` child stays in it; `launchctl bootout` does not stop that child, but a stop by coalition does.
- **Nested sandboxes:** a process in a Seatbelt sandbox cannot start a second one (`sandbox_apply: Operation not permitted`).
- **Separate calls are separate sandboxes,** also with the same profile. A process can signal the processes of its own sandbox only. `kill(pid, 0)` also succeeds for a zombie.
- **Network rules:** a rule accepts only `*` or `localhost` as the host, and no port ranges. A rule that allows a bind only on `localhost` still permits a bind on `0.0.0.0`, and a connection from the LAN is accepted.
- **`sandbox_check`** from outside the sandbox cannot identify the sandbox of a process.
- **The terminal:** Node in a launchd job that gets the descriptors of a terminal (`SCM_RIGHTS`) has a TTY of the correct size, raw mode, and the replies to terminal queries.
- **Privacy permissions:** a launchd job does not get the permissions of Terminal. When the program of the job is a platform binary (`/bin/sh`), macOS denies the access without a prompt. When it is `mina-instance`, macOS asks once, for `mina-instance`, and the grant does not extend to Node outside Mina. A rebuild asks again.
- **Memory:** macOS refuses to lower `RLIMIT_AS`. A jetsam limit, set when the process is spawned, is enforced by the kernel; an `exec` resets it, and a child does not inherit it.
- **A launchd job for each call** costs about 30 to 50 ms to start; `sandbox-exec` alone costs about 11 ms.

## Sources

- OpenAI Codex, `codex-rs/sandboxing/src/seatbelt*.sbpl` and `seatbelt.rs` (Apache-2.0): the base policy, the read-only platform defaults, the `fcntl` and XPC denies, and the root anchor denies.
- eugene1g/agent-safehouse, `profiles/10-system-runtime.sb` (Apache-2.0): system paths, the `procargs` and `pidinfo` denies, the launchd listener denies, and the macOS 27 `/pkg` rule.
- Anthropic sandbox-runtime (Apache-2.0): violation tags, the proxy token, and profile size limits. Mina does not use its read model.
- NixOS Nix, `sandbox-defaults.sb` (LGPL-2.1): metadata access to parent folders, and `(with no-log)`. Ideas only, no code.
- Apple XNU (`bsd/sys/proc_info_private.h`, `libsyscall/wrappers/spawn/spawn_private.h`): resource coalitions and the jetsam memory limit of `posix_spawn`.
- Apple: macOS 27 release notes, the security notes for 27.0 and 27.2, and TN3179 (local network privacy).
