// An integrated shell, rooted at the open project.
//
// HONEST LIMITATION, stated here because the UI must not imply otherwise: this
// is a pipe to a shell, not a PTY. `node-pty` would give a real terminal —
// job control, curses apps, `vim`, colour negotiation — but it is a native
// module that has to be rebuilt against Electron's ABI, and a design tool
// should not fail to launch because a terminal add-on failed to compile.
//
// What this does give, which is what the task actually needs: run `make`, run
// the design binary, run `git`, read the output, in the project directory,
// without leaving the app. Line-oriented commands work; full-screen ones do
// not, and the pane says so rather than hanging.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as os from 'os';

export interface TerminalEvents {
  onData(chunk: string): void;
  onExit(code: number | null): void;
}

/** The user's login shell, or a sane default per platform. */
function defaultShell(): { cmd: string; args: string[] } {
  if (process.platform === 'win32') return { cmd: process.env.COMSPEC ?? 'cmd.exe', args: [] };
  const shell = process.env.SHELL ?? '/bin/bash';
  // Interactive so rc files load and the prompt exists; -s reads from stdin.
  return { cmd: shell, args: ['-i', '-s'] };
}

export class Terminal {
  private child: ChildProcessWithoutNullStreams | null = null;

  constructor(
    private cwd: string,
    private events: TerminalEvents,
  ) {}

  start(): void {
    if (this.child) return;
    const { cmd, args } = defaultShell();
    this.child = spawn(cmd, args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        // No PTY means no terminal size and no colour negotiation; say so
        // rather than letting tools guess and emit escape soup.
        TERM: 'dumb',
        PS1: '$ ',
      },
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.on('data', (b: Buffer) => this.events.onData(b.toString()));
    this.child.stderr.on('data', (b: Buffer) => this.events.onData(b.toString()));
    this.child.on('exit', (code) => {
      this.child = null;
      this.events.onExit(code);
    });
    this.child.on('error', (err) => this.events.onData(`\n${String(err)}\n`));

    this.events.onData(
      `ISS integrated shell — ${cmd} in ${this.cwd}${os.EOL}` +
        `Line-oriented commands only (no PTY): make, ./build/design, git…${os.EOL}`,
    );
  }

  /** One line of input. The caller supplies the newline semantics. */
  write(data: string): void {
    if (!this.child) this.start();
    this.child?.stdin.write(data);
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
  }
}
