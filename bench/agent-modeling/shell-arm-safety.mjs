// The three.js and llms-only arms hand the benchmarked agent a shell on the machine that runs the bench.
// On 2026-11-13 an agent cleaned up its headless Chrome with `taskkill //F //IM chrome.exe //T` and
// `Get-Process chrome,node | Stop-Process -Force`, which killed the owner's browser and every node process (#1138).

/** Permission rules that keep the benchmarked agent from stopping processes or opening another shell. */
export const SHELL_ARM_DENIED_TOOLS = [
  'PowerShell',
  'Bash(taskkill:*)',
  'Bash(tskill:*)',
  'Bash(kill:*)',
  'Bash(pkill:*)',
  'Bash(killall:*)',
  'Bash(Stop-Process:*)',
  'Bash(Get-Process:*)',
  'Bash(wmic:*)',
  'Bash(powershell:*)',
  'Bash(powershell.exe:*)',
  'Bash(pwsh:*)',
  'Bash(pwsh.exe:*)',
  'Bash(cmd:*)',
  'Bash(cmd.exe:*)',
];

export const SHELL_ARM_PROCESS_RULE = `Never stop, kill or list processes (no taskkill, kill, pkill, Stop-Process): other programs run on this machine.
Your script must close the browser it starts (await browser.close() in a finally block).`;

export const SHELL_ARM_OPT_IN_VARIABLE = 'AGENT_BENCH_SHELL_ARMS';

/** Throws unless the operator opted in, because the agent gets a real shell on this machine. */
export function assertShellArmAllowed(environment = process.env) {
  if (environment[SHELL_ARM_OPT_IN_VARIABLE] === '1') return;
  throw new Error(`This bench arm gives the agent a shell on this machine. Run it on a machine where nothing else runs, then set ${SHELL_ARM_OPT_IN_VARIABLE}=1 to start it. See bench/agent-modeling/README.md, "Shell arms".`);
}
