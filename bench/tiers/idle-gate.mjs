// Idle gate for the tier benchmark: waits until the card is quiet, then runs one command while recording how busy the card was.
//
// As a command (shell and Python runners use this form):
//   node bench/tiers/idle-gate.mjs [--out <file.gate.json>] [--threshold 15] [--consecutive 5] [--max-wait 600] [--contended-above 30] [--report-only] -- <command> [arguments...]
//   without "-- <command>" it only waits and prints the gate result.
// As a module (the Node runners): import { runGated } from './idle-gate.mjs'.
//
// Steps: (1) poll nvidia-smi every second until utilisation is at or under --threshold on --consecutive polls in a row, or --max-wait
// seconds pass; (2) sample the card for 3 s as the background figure, because the job itself drives utilisation once it starts;
// (3) run the command and sample utilisation while it runs. A run whose background mean is over --contended-above is marked contended:
// the table generator keeps it in the raw cells and leaves it out of medians. --report-only (or TIER_GATE_REPORT_ONLY=1) never waits and
// never fails; it only records, which is for checking the plumbing on a busy card.
// Exit code: the command's own; 3 when the gate times out and the command was not run (gate only mode exits 3 as well).
import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

export const GATE_DEFAULTS = {
  thresholdPercent: Number(process.env.TIER_GATE_THRESHOLD ?? 15),
  consecutivePolls: Number(process.env.TIER_GATE_CONSECUTIVE ?? 5),
  maxWaitSeconds: Number(process.env.TIER_GATE_MAX_WAIT ?? 600),
  contendedAbovePercent: Number(process.env.TIER_GATE_CONTENDED_ABOVE ?? 30),
  backgroundSeconds: 3,
  runPollMilliseconds: 250,
  reportOnly: process.env.TIER_GATE_REPORT_ONLY === '1',
};

// Windows desktop programs that always show up in the compute list; they are not jobs that load the card.
const DESKTOP_SHELL_BINARIES = new Set([
  'applicationframehost.exe', 'cloudflare warp.exe', 'discord.exe', 'explorer.exe', 'logioptionsplus_agent.exe', 'msedgewebview2.exe',
  'oh-snap.exe', 'powertoys.colorpickerui.exe', 'powertoys.fancyzones.exe', 'searchhost.exe', 'shellexperiencehost.exe', 'shellhost.exe',
  'startmenuexperiencehost.exe', 'systemsettings.exe', 'textinputhost.exe', 'zalo.exe', 'zalocall.exe',
]);

const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));

export function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((first, second) => first - second);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

export async function readCard() {
  const { stdout } = await runFile('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits']);
  const [utilizationPercent, memoryMebibytes] = stdout.trim().split(/\r?\n/)[0].split(',').map(Number);
  return { utilizationPercent, memoryMebibytes };
}

// Programs holding the card, without the desktop shell. `available` is false when the driver reports no list (Windows often does not).
export async function listForeignProcesses() {
  try {
    const { stdout } = await runFile('nvidia-smi', ['--query-compute-apps=pid,process_name', '--format=csv,noheader']);
    const names = stdout.split(/\r?\n/).filter(Boolean).map(line => {
      const separator = line.indexOf(',');
      return line.slice(separator + 1).trim().split(/[\\/]/).pop();
    });
    const jobs = names.filter(name => !DESKTOP_SHELL_BINARIES.has(name.toLowerCase()));
    return { available: names.length > 0, names: [...new Set(jobs)].sort() };
  } catch (error) {
    return { available: false, names: [], error: error.message };
  }
}

function summarize(utilizations) {
  return { utilMedian: median(utilizations), utilMean: utilizations.length ? utilizations.reduce((sum, value) => sum + value, 0) / utilizations.length : null, utilMax: utilizations.length ? Math.max(...utilizations) : null, samples: utilizations.length };
}

// Polls once a second until utilisation is at or under the threshold on `consecutivePolls` polls in a row.
export async function waitForIdle(options = {}) {
  const { thresholdPercent, consecutivePolls, maxWaitSeconds, reportOnly } = { ...GATE_DEFAULTS, ...options };
  const started = Date.now();
  const recent = [];
  let quietPolls = 0;
  while (true) {
    const { utilizationPercent } = await readCard();
    recent.push(utilizationPercent);
    quietPolls = utilizationPercent <= thresholdPercent ? quietPolls + 1 : 0;
    const waitedSeconds = (Date.now() - started) / 1000;
    if (quietPolls >= consecutivePolls) return { idle: true, timedOut: false, reportOnly, waitedSeconds, thresholdPercent, consecutivePolls, maxWaitSeconds, lastPolls: recent.slice(-10) };
    if (reportOnly) return { idle: false, timedOut: false, reportOnly, waitedSeconds, thresholdPercent, consecutivePolls, maxWaitSeconds, lastPolls: recent.slice(-10) };
    if (waitedSeconds >= maxWaitSeconds) {
      return {
        idle: false, timedOut: true, reportOnly, waitedSeconds, thresholdPercent, consecutivePolls, maxWaitSeconds, lastPolls: recent.slice(-10),
        message: `Card not idle after ${Math.round(waitedSeconds)} s: needs at most ${thresholdPercent}% on ${consecutivePolls} polls in a row, last polls ${recent.slice(-5).join(', ')}%. Other jobs are using it; stop them, raise --max-wait, or pass --report-only to record without waiting.`,
      };
    }
    await sleep(1000);
  }
}

// The 3 s before a run: the load other programs put on the card, measured while our job is not running.
export async function sampleBackground(seconds = GATE_DEFAULTS.backgroundSeconds) {
  const utilizations = [];
  const started = Date.now();
  while ((Date.now() - started) / 1000 < seconds) {
    utilizations.push((await readCard()).utilizationPercent);
    await sleep(250);
  }
  const foreign = await listForeignProcesses();
  return { ...summarize(utilizations), foreignProcesses: foreign.names, computeAppsAvailable: foreign.available };
}

function startRunSampler(intervalMilliseconds) {
  const utilizations = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      utilizations.push((await readCard()).utilizationPercent);
      await sleep(intervalMilliseconds);
    }
  })();
  return async () => {
    running = false;
    await loop;
    return summarize(utilizations);
  };
}

// Gate, background sample, then the command (spawned with `spawnOptions`) with a sampler running. Returns the gate record and the exit code.
export async function runGated(command, commandArguments, options = {}, spawnOptions = { stdio: 'inherit' }) {
  const settings = { ...GATE_DEFAULTS, ...options };
  const gate = await waitForIdle(settings);
  if (gate.timedOut) {
    console.error(gate.message);
    return { exitCode: 3, record: { gate, ran: false, contended: true, contendedReason: 'gate timed out' } };
  }
  const background = await sampleBackground(settings.backgroundSeconds);
  const stopSampler = startRunSampler(settings.runPollMilliseconds);
  const started = Date.now();
  const exitCode = await new Promise(done => {
    const child = spawn(command, commandArguments, spawnOptions);
    child.on('error', error => { console.error(`Could not start ${command}: ${error.message}`); done(127); });
    child.on('close', code => done(code ?? 1));
  });
  const wallSeconds = (Date.now() - started) / 1000;
  const run = await stopSampler();
  // The mean, not the median, so a spike from another job inside the 3 s counts.
  const contended = background.utilMean > settings.contendedAbovePercent;
  const record = {
    ran: true,
    exitCode,
    gate,
    background,
    run: { ...run, wallSeconds },
    contended,
    contendedReason: contended ? `background utilisation mean ${background.utilMean.toFixed(0)}% (max ${background.utilMax}%) over ${settings.contendedAbovePercent}%` : null,
    contendedAbovePercent: settings.contendedAbovePercent,
  };
  return { exitCode, record };
}

function parseArguments(argumentList) {
  const separator = argumentList.indexOf('--');
  const flags = separator === -1 ? argumentList : argumentList.slice(0, separator);
  const command = separator === -1 ? [] : argumentList.slice(separator + 1);
  const value = (flag, fallback) => (flags.includes(flag) ? flags[flags.indexOf(flag) + 1] : fallback);
  return {
    command,
    out: value('--out', null),
    options: {
      thresholdPercent: Number(value('--threshold', GATE_DEFAULTS.thresholdPercent)),
      consecutivePolls: Number(value('--consecutive', GATE_DEFAULTS.consecutivePolls)),
      maxWaitSeconds: Number(value('--max-wait', GATE_DEFAULTS.maxWaitSeconds)),
      contendedAbovePercent: Number(value('--contended-above', GATE_DEFAULTS.contendedAbovePercent)),
      reportOnly: flags.includes('--report-only') || GATE_DEFAULTS.reportOnly,
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { command, out, options } = parseArguments(process.argv.slice(2));
  let exitCode;
  let record;
  if (command.length === 0) {
    const gate = await waitForIdle(options);
    if (gate.timedOut) console.error(gate.message);
    record = { ran: false, gate };
    exitCode = gate.timedOut ? 3 : 0;
  } else {
    ({ exitCode, record } = await runGated(command[0], command.slice(1), options));
  }
  if (out) {
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(resolve(out), `${JSON.stringify(record, null, 1)}\n`);
  } else {
    console.log(JSON.stringify(record));
  }
  process.exit(exitCode);
}
