import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SHELL_ARM_DENIED_TOOLS,
  SHELL_ARM_OPT_IN_VARIABLE,
  SHELL_ARM_PROCESS_RULE,
  assertShellArmAllowed,
} from '../bench/agent-modeling/shell-arm-safety.mjs';
import { THREEJS_PREAMBLE } from '../bench/agent-modeling/threejs.mjs';

const SHELL_ARMS = ['bench/agent-modeling/threejs.mjs', 'bench/agent-modeling/llms-only.mjs'];

test('the shell arms deny the commands that stop processes or open another shell', () => {
  for (const command of ['taskkill', 'kill', 'pkill', 'killall', 'Stop-Process', 'Get-Process', 'wmic', 'powershell', 'pwsh', 'cmd']) {
    assert.ok(SHELL_ARM_DENIED_TOOLS.includes(`Bash(${command}:*)`), `${command} is denied`);
  }
  assert.ok(SHELL_ARM_DENIED_TOOLS.includes('PowerShell'));
});

test('a shell arm starts only when the operator opts in', () => {
  assert.throws(() => assertShellArmAllowed({}), new RegExp(`${SHELL_ARM_OPT_IN_VARIABLE}=1`));
  assert.throws(() => assertShellArmAllowed({ [SHELL_ARM_OPT_IN_VARIABLE]: 'yes' }));
  assert.doesNotThrow(() => assertShellArmAllowed({ [SHELL_ARM_OPT_IN_VARIABLE]: '1' }));
});

test('both shell arms pass the deny rules, check the opt-in and tell the agent the process rule', async () => {
  for (const path of SHELL_ARMS) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(source, /'--disallowedTools', \.\.\.BUILT_IN_TOOLS_DENIED, \.\.\.SHELL_ARM_DENIED_TOOLS/, `${path} passes the deny rules`);
    assert.match(source, /assertShellArmAllowed\(\)/, `${path} checks the opt-in`);
    assert.match(source, /\$\{SHELL_ARM_PROCESS_RULE\}`;/, `${path} adds the process rule to its prompt`);
  }
  assert.ok(THREEJS_PREAMBLE.endsWith(SHELL_ARM_PROCESS_RULE));
});
