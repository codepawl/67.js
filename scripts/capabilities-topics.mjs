// scene_capabilities answers with a short index and serves the detail by topic, so the tool schemas stay small.
// A topic is a key of the scene capabilities, a runtime section (jobs, assets, ...) or the outline of a full input schema
// (motion, environment, meshEdit, ...). A union such as meshEdit takes a branch: meshEdit.bevel.
import * as z from 'zod/v4';
import { outlineSchema, unionBranches } from './schema-outline.mjs';
import { AGENT_TOOL_EXAMPLES } from './tool-examples.mjs';

const RUNTIME_SECTIONS = ['sceneLimits', 'preview', 'review', 'assets', 'packs', 'jobs', 'addons', 'unsupported'];
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
  topics.set('examples', AGENT_TOOL_EXAMPLES);
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
  const withDefinitions = part => ({ ...part, ...(jsonSchema.$defs ? { $defs: jsonSchema.$defs } : {}) });
  if (!branchName) return branches ? unionIndex(topic, branches) : outlineSchema(jsonSchema);
  if (branches?.has(branchName)) return outlineSchema(withDefinitions(branches.get(branchName)));
  // A short name such as inset or extrude stands for every branch that starts with it: inset_region and inset_individual.
  const prefixed = branches ? [...branches].filter(([name]) => name.startsWith(`${branchName}_`)) : [];
  if (prefixed.length === 1) return outlineSchema(withDefinitions(prefixed[0][1]));
  if (prefixed.length > 1) return unionIndex(topic, new Map(prefixed));
  // A dotted field of a plain topic, such as environment.spotLights, is that field's outline.
  const field = jsonSchema.properties?.[branchName];
  if (!branches && field) return outlineSchema(withDefinitions(field));
  const known = branches ? [...branches.keys()] : Object.keys(jsonSchema.properties ?? {});
  const sharedField = branches && [...branches.values()].some(branch => branch.properties?.[branchName]);
  const fieldNote = sharedField ? ` ${branchName} is a field of those branches, not a branch: open one branch to see it.` : '';
  throw new Error(`Topic ${topic} has no ${branches ? 'branch' : 'field'} ${branchName}. ${branches ? 'Branches' : 'Fields'}: ${known.join(', ') || 'none'}.${fieldNote}`);
}

/** A near miss of a topic name: a leading "scene." is dropped, and a name that contains or is contained by exactly one topic (uvs for meshUv) stands for it. */
function closestTopic(name, allNames) {
  if (allNames.includes(name)) return name;
  const stem = name.toLowerCase().replace(/s$/, '');
  const near = stem.length < 2 ? [] : allNames.filter(candidate => {
    const lowered = candidate.toLowerCase();
    return lowered.includes(stem) || (lowered.length > 2 && stem.includes(lowered));
  });
  return near.length === 1 ? near[0] : undefined;
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
      how: 'Call scene_capabilities with topic set to a name below. Tools list common fields; schemas names the full field list of a recipe part (meshEdit and meshStack also take <name>.<op>, geometries takes geometries.<type>). examples.<tool> is one complete call.',
      topics: names,
    };
  }
  const allNames = [...names.scene, ...names.runtime, ...names.schemas];
  const parts = topic.split('.');
  if (parts[0] === 'scene' && parts.length > 1) parts.shift();
  const [requestedName, branchName] = parts;
  const name = closestTopic(requestedName, allNames) ?? requestedName;
  const notes = sceneTopics(capabilities.scene).get(name);
  const runtime = RUNTIME_SECTIONS.includes(name) ? capabilities[name] : undefined;
  const source = outlineSources.get(name);
  const found = [notes, runtime, source].some(value => value !== undefined);
  if (!found) {
    throw new Error(`Unknown topic ${topic}. Topics: ${allNames.join(', ')}.`);
  }
  const answeredTopic = [name, branchName].filter(Boolean).join('.');
  if (source) return { topic: answeredTopic, ...(notes === undefined ? {} : { notes }), fields: outlineAnswer(name, branchName, source) };
  // A dotted name picks one entry of a plain topic: examples.scene_apply.
  const entry = notes !== null && typeof notes === 'object' && branchName !== undefined && Object.hasOwn(notes, branchName);
  if (entry) return { topic: answeredTopic, value: notes[branchName] };
  return { topic: answeredTopic, value: notes ?? runtime };
}
