import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { listTools } from '../scripts/measure-tool-cost.mjs';
import { checkToolSchemas, summarizeFindings, TOOL_NAME_PATTERN } from '../scripts/check-tool-schemas.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const siteOrigin = 'https://67js.codepawl.com';
const tools = await listTools();

function createStrictValidator() {
  const validator = new Ajv2020({ strict: true });
  addFormats(validator);
  return validator;
}
const findings = checkToolSchemas(tools);

function formatFindings(items) {
  return items.map(item => `${item.rule} ${item.path}: ${item.detail}`).join('\n');
}

test('every tool passes the rules all clients enforce', () => {
  const portableFindings = findings.filter(item => item.profile === 'portable');
  assert.equal(portableFindings.length, 0, formatFindings(portableFindings));
});

test('tool names use only the characters and length that OpenAI, Gemini and Anthropic accept', () => {
  for (const tool of tools) {
    assert.match(tool.name, TOOL_NAME_PATTERN);
  }
});

test('every input schema compiles under a strict JSON Schema 2020-12 validator', () => {
  for (const tool of tools) {
    const validator = createStrictValidator();
    assert.doesNotThrow(() => validator.compile(tool.inputSchema), `${tool.name} does not compile in strict mode`);
  }
});

test('every tool accepts an empty-argument call only when it has no required fields', () => {
  for (const tool of tools) {
    const validate = createStrictValidator().compile(tool.inputSchema);
    const required = tool.inputSchema.required ?? [];
    assert.equal(validate({}), required.length === 0, `${tool.name} required fields ${JSON.stringify(required)}`);
  }
});

test('strict-mode and subset gaps are the known ones, so a new kind of gap is noticed', () => {
  const knownGaps = {
    'openai-strict': ['optional-properties', 'additional-properties-not-false', 'keyword-oneOf', 'keyword-prefixItems', 'any-value-schema', 'keyword-propertyNames', 'nesting-depth'],
    'gemini-subset': ['keyword-const', 'keyword-oneOf', 'keyword-$ref', 'any-value-schema', 'keyword-propertyNames', 'keyword-exclusiveMinimum', 'keyword-exclusiveMaximum'],
  };
  const summary = summarizeFindings(findings);
  for (const [profile, rules] of Object.entries(knownGaps)) {
    const unexpected = Object.keys(summary[profile] ?? {}).filter(rule => !rules.includes(rule));
    assert.deepEqual(unexpected, [], `${profile} gained a new kind of finding; fix it or list it in docs/mcp.md`);
  }
});

function linkedPaths(text) {
  const absolute = [...text.matchAll(new RegExp(`${siteOrigin.replaceAll('.', '\\.')}(/[A-Za-z0-9._/-]*)`, 'g'))].map(match => match[1]);
  const bare = [...text.matchAll(/`(\/[a-z0-9-]+\.(?:md|html|txt|json))`/g)].map(match => match[1]);
  return [...new Set([...absolute, ...bare])];
}

function pageSources(path) {
  const name = path.replace(/^\//, '');
  return [`public/${name}`, `docs/${name}`, `site/${name}`, name, name === 'changelog.md' ? 'CHANGELOG.md' : null].filter(Boolean);
}

test('every page that llms.txt and the README link to exists in the package or on the site', () => {
  const documents = ['public/llms.txt', 'README.md'].map(file => ({ file, text: readFileSync(`${repositoryRoot}${file}`, 'utf8') }));
  const missing = [];
  for (const { file, text } of documents) {
    for (const path of linkedPaths(text)) {
      if (path === '/' || path === '/release.json' || path === '/changelog.json') continue;
      const found = pageSources(path).some(source => existsSync(`${repositoryRoot}${source}`));
      if (!found) missing.push(`${file} links ${path}`);
    }
  }
  assert.deepEqual(missing, []);
});
