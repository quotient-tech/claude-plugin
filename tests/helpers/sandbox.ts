// A throwaway HOME for running a plugin's commands: every XDG directory and
// ~/.claude live under one temp dir, so no test can read or write the real
// home directory.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  /** The plugin whose commands this sandbox runs. */
  pluginRoot: string;
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Creates a throwaway HOME, with XDG directories inside it, for one plugin's commands.
 * @param plugin - The directory name under plugins/ the sandbox runs.
 * @returns The sandbox's paths and environment.
 */
export function sandbox(plugin = "quotient"): Sandbox {
  const pluginRoot = join(import.meta.dirname, "../../plugins", plugin);
  // realpath: on macOS mkdtemp gives /var/..., but tools report /private/var/...
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${plugin}-`)));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    CLAUDE_PLUGIN_ROOT: pluginRoot,
  };
  return { pluginRoot, root, home, env };
}

/**
 * Runs a command without blocking the event loop.
 * @param file - The program to run.
 * @param args - Its arguments.
 * @param env - Its whole environment.
 * @returns Its exit status and output, once it exits.
 */
export function runAsync(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
