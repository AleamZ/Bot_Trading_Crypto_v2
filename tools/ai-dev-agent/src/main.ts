import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDefaultRunner } from "./commandRunner.js";
import { loadConfig, type AgentConfig } from "./config.js";
import { AgentCycle, type CycleOptions } from "./cycle.js";
import { OpenAiCompatibleClient } from "./llm.js";
import { NodeToolchain } from "./toolchain.js";

interface CliArgs {
  once: boolean;
  digestOnly: boolean;
  force: boolean;
  fromStart: boolean;
  logPaths: string[];
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { once: false, digestOnly: false, force: false, fromStart: false, logPaths: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") args.once = true;
    else if (arg === "--digest-only") args.digestOnly = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--from-start") args.fromStart = true;
    else if (arg === "--log") {
      const value = argv[i + 1];
      if (!value) throw new Error("--log requires a path");
      args.logPaths.push(resolve(process.env.INIT_CWD ?? process.cwd(), value));
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: tsx src/main.ts [--once] [--digest-only] [--force] [--from-start] [--log <path>]...
  (no flag)       run the loop every INTERVAL_MINUTES
  --once          run a single cycle and exit
  --digest-only   print the log digest and exit (no LLM, no git, cursor not advanced)
  --force         ignore MIN_NEW_LINES / MIN_SIGNAL_EVENTS
  --from-start    with --digest-only: read the logs from the beginning
  --log <path>    override LOG_PATHS (repeatable)`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function acquireLock(config: AgentConfig): () => void {
  mkdirSync(config.stateDir, { recursive: true });
  const lockFile = join(config.stateDir, "agent.lock");
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, "utf8").trim());
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive && pid !== process.pid) throw new Error(`another ai-dev-agent is running (pid ${pid}); lock: ${lockFile}`);
  }
  writeFileSync(lockFile, String(process.pid));
  return () => rmSync(lockFile, { force: true });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const runner = createDefaultRunner();
  const cycle = new AgentCycle({
    config,
    runner,
    llm: new OpenAiCompatibleClient(config.ai),
    toolchain: new NodeToolchain(runner, config.repoPath, config.worktreeInstall, config.testTimeoutMs)
  });
  const options: CycleOptions = { force: args.force, fromStart: args.fromStart };
  if (args.logPaths.length) options.logPaths = args.logPaths;

  if (args.digestOnly) {
    const result = await cycle.run({ ...options, digestOnly: true });
    console.log(result.digestText ?? "");
    return;
  }

  const release = acquireLock(config);
  process.on("exit", release);
  console.log(
    `[ai-dev-agent] repo=${config.repoPath} base=${config.remote}/${config.baseBranch} model=${config.ai.model} @ ${config.ai.baseUrl} dryRun=${config.dryRun} interval=${config.intervalMinutes}m`
  );
  if (config.dryRun) console.log("[ai-dev-agent] DRY-RUN is ON: nothing will be pushed and no PR will be opened (set AI_DEV_AGENT_DRY_RUN=false to publish).");

  const runOnce = async () => {
    try {
      const result = await cycle.run(options);
      console.log(`[ai-dev-agent] cycle: ${result.decision} - ${result.detail}${result.reportPath ? ` (report: ${result.reportPath})` : ""}`);
    } catch (error) {
      console.error(`[ai-dev-agent] cycle crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
  };

  if (args.once) {
    await runOnce();
    return;
  }

  let stopping = false;
  let wake: (() => void) | null = null;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopping) {
    await runOnce();
    if (stopping) break;
    await new Promise<void>((resolveSleep) => {
      const timer = setTimeout(resolveSleep, config.intervalMinutes * 60_000);
      wake = () => {
        clearTimeout(timer);
        resolveSleep();
      };
    });
    wake = null;
  }
  console.log("[ai-dev-agent] stopped");
}

main().catch((error: unknown) => {
  console.error(`[ai-dev-agent] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
