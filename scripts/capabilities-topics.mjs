// scene_capabilities answers with a short index and serves the detail by topic, so the tool schemas stay small.
// A topic is a key of the scene capabilities, a runtime section (jobs, assets, ...) or the outline of a full input schema
// (motion, environment, meshEdit, ...). A union such as meshEdit takes a branch: meshEdit.bevel.
import * as z from 'zod/v4';
import { outlineSchema, unionBranches } from './schema-outline.mjs';

const RUNTIME_SECTIONS = ['sceneLimits', 'preview', 'review', 'assets', 'jobs', 'unsupported'];
const SUMMARY_LENGTH = 110;
// Scalars (booleans and numbers) of the scene capabilities share one topic instead of one each.
const FLAGS_TOPIC = 'flags';

function isScalar(value) {
  return typeof value === 'boolean' || typeof value === 'number';
}

function firstSentence(text = '') {
  const sentence = text.split(/\.\s/)[0].replace(/\.$/, '');
  return sentence.length > SUMMARY_LENGTH ? `${sentence.slice(0, SUMMARY_LENGTH - 1)}…` : sentence;
}

function sceneTopics(scene) {
  const topics = new Map();
  const flags = {};
  for (const [name, value] of Object.entries(scene)) {
    if (isScalar(value)) flags[name] = value;
    else topics.set(name, value);
  }
  topics.set(FLAGS_TOPIC, flags);
  return topics;
}

function inputJsonSchema(schema) {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
}

function branchSummary(branch) {
  const fields = Object.keys(branch.properties ?? {}).filter(name => !(branch.properties[name].const !== undefined));
  return { fields, ...(branch.description ? { note: firstSentence(branch.description) } : {}) };
}

function unionIndex(topic, branches) {
  const entries = {};
  for (const [name, branch] of branches) entries[name] = branchSummary(branch);
  return { branches: entries, use: `topic ${topic}.<name> for the fields of one branch; modifier ops not listed here are in meshModifiers` };
}

function outlineAnswer(topic, branchName, schema) {
  const jsonSchema = inputJsonSchema(schema);
  const branches = unionBranches(jsonSchema);
  if (!branchName) return branches ? unionIndex(topic, branches) : outlineSchema(jsonSchema);
  if (!branches?.has(branchName)) {
    const known = branches ? [...branches.keys()].join(', ') : 'none: this topic has no branches';
    throw new Error(`Topic ${topic} has no branch ${branchName}. Branches: ${known}.`);
  }
  return outlineSchema({ ...branches.get(branchName), ...(jsonSchema.$defs ? { $defs: jsonSchema.$defs } : {}) });
}

/** The topics a caller can ask for, by name. */
export function capabilityTopicNames(capabilities, outlineSources) {
  const names = {
    scene: [...sceneTopics(capabilities.scene).keys()],
    runtime: RUNTIME_SECTIONS,
    schemas: [...outlineSources.keys()],
  };
  return names;
}

/** The index with no topic, or the detail of one topic. */
export function answerCapabilities(capabilities, topic, outlineSources) {
  const names = capabilityTopicNames(capabilities, outlineSources);
  if (topic === undefined) {
    return {
      format: capabilities.scene.format, schemaVersion: capabilities.scene.schemaVersion,
      phase: capabilities.phase, availableIn: capabilities.availableIn,
      how: 'Call scene_capabilities with topic set to a name below. Tools list common fields; schemas names the full field list of a recipe part (meshEdit and meshStack also take <name>.<op>, geometries takes geometries.<type>).',
      topics: names,
    };
  }
  const [name, branchName] = topic.split('.');
  const notes = sceneTopics(capabilities.scene).get(name);
  const runtime = RUNTIME_SECTIONS.includes(name) ? capabilities[name] : undefined;
  const source = outlineSources.get(name);
  const found = [notes, runtime, source].some(value => value !== undefined);
  if (!found) {
    throw new Error(`Unknown topic ${topic}. Topics: ${[...names.scene, ...names.runtime, ...names.schemas].join(', ')}.`);
  }
  if (source) return { topic, ...(notes === undefined ? {} : { notes }), fields: outlineAnswer(name, branchName, source) };
  return { topic, value: notes ?? runtime };
}
