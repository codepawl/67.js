// Splits a showcase world's GLB into a small first part (the ground and the hero asset the default camera frames) and the
// rest, and writes a small preview of the sky, so the showcase page can draw a first frame before the whole world arrives.
//
//   node scripts/split-showcase-glb.mjs <port|airport|datacenter> --source <full.glb> [--dry-run]
//
// The source is the world as one GLB. The committed split files replace it, so recover the original from the commit before the
// split: `git show <commit-before-the-split>:public/showcase/<id>/scene.glb > full.glb`.
//
// Nothing is re-quantized and no texture is touched: every compressed vertex stream, image and material is copied byte for byte
// and every kept node keeps its transform. The one thing rewritten is the shared meshopt index stream. Its indices are decoded,
// cut per accessor and encoded again (a lossless step), because one stream serves every mesh and cannot be cut in its
// compressed form. A mesh used by several nodes goes to one part together with all of its nodes, so instancing survives.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MeshoptEncoder } from 'meshoptimizer';
import { parseRadianceHdr } from '../src/hdri.js';

const SHOWCASE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'showcase');
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BINARY_CHUNK = 0x004e4942;
const MESHOPT = 'EXT_meshopt_compression';
const PREVIEW_SKY_WIDTH = 256;
const PREVIEW_SKY_HEIGHT = 128;
// A 1x1 PNG that stands in for a shared texture's image in every file but the first. The page never decodes it: the later file
// takes the texture the first file decoded, found by the key in the texture's extras.sharedTexture.
const STAND_IN_IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// The nodes (by name) that make the first part. They are the ground and the hero the default camera frames; every other
// node goes to the rest. A name picks every node that carries it.
const FIRST_PART_NODE_NAMES = {
  port: ['harbour_water', 'ground_baked', 'quay_concrete', 'far_ridge', 'ship_hull', 'glass', 'glow_window'],
  airport: ['concrete', 'asphalt', 'aircraft'],
  datacenter: ['hall_floor', 'rack_front*'],
};

// Materials of the first part's meshes whose primitives load with the rest: the airliner's landing gear detail, which is small on
// screen and shares its textures with the ramp equipment in the rest.
const LATER_MATERIAL_NAMES = {
  airport: ['gear_paint', 'paint_grey', 'steel', 'paint_grime', 'dark_metal', 'chrome', 'tyre_rubber', 'hub_grey', 'brake_steel', 'plastic_black', 'Rubber', 'Landing_Gear_Black', 'landing_Gear', 'Gear_Door_Metal', 'Gear_Door_Metal.001', 'Gear_Well', 'Wheel'],
};

function readGlb(buffer) {
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new Error('Not a GLB file.');
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  const binaryStart = 20 + jsonLength;
  if (buffer.readUInt32LE(binaryStart + 4) !== BINARY_CHUNK) throw new Error('The GLB has no binary chunk.');
  const binaryLength = buffer.readUInt32LE(binaryStart);
  return { json, binary: buffer.subarray(binaryStart + 8, binaryStart + 8 + binaryLength) };
}

function writeGlb(json, binary) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const binaryPadded = Buffer.concat([binary, Buffer.alloc((4 - (binary.length % 4)) % 4)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binaryPadded.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.writeUInt32LE(JSON_CHUNK, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binaryPadded.length, 0);
  binaryHeader.writeUInt32LE(BINARY_CHUNK, 4);
  return Buffer.concat([header, jsonHeader, jsonPadded, binaryHeader, binaryPadded]);
}

function componentBytes(componentType) {
  return { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[componentType];
}

const TYPE_WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

// Every `index` inside a material is a texture reference (texture infos, also inside extensions).
function remapTextureIndices(value, textureMap) {
  if (Array.isArray(value)) return value.map(item => remapTextureIndices(item, textureMap));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => (
      key === 'index' && typeof inner === 'number' ? [key, textureMap.get(inner)] : [key, remapTextureIndices(inner, textureMap)]
    )));
  }
  return value;
}

function collectTextureIndices(value, found) {
  if (Array.isArray(value)) value.forEach(item => collectTextureIndices(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'index' && typeof inner === 'number') found.add(inner);
      else collectTextureIndices(inner, found);
    }
  }
}

const STAND_IN = Symbol('stand-in image');

class SourceWorld {
  constructor(buffer) {
    ({ json: this.json, binary: this.binary } = readGlb(buffer));
    this.decodedIndexViews = new Map();
    this.parentOf = new Map();
    this.json.nodes.forEach((node, index) => (node.children ?? []).forEach(child => this.parentOf.set(child, index)));
    for (const key of ['animations', 'cameras']) {
      if (this.json[key]?.length) throw new Error(`The splitter does not handle ${key}.`);
    }
    this.drawOrder = this.listDrawOrder();
  }

  // The parts the glTF loader makes, in its order: nodes depth first, each mesh node's primitives, each primitive's instances.
  // A part's place in this list is its rank; the page sorts the parts of all files by rank to restore the one-piece order,
  // which fixes the order the renderer batches and draws them in.
  listDrawOrder() {
    const order = [];
    const visit = nodeIndex => {
      const node = this.json.nodes[nodeIndex];
      if (node.mesh !== undefined) {
        const instancing = node.extensions?.EXT_mesh_gpu_instancing;
        const instanceCount = instancing ? this.json.accessors[Object.values(instancing.attributes)[0]].count : 1;
        this.json.meshes[node.mesh].primitives.forEach((primitive, primitiveIndex) => {
          for (let instance = 0; instance < instanceCount; instance++) order.push({ nodeIndex, primitive, primitiveIndex });
        });
      }
      (node.children ?? []).forEach(visit);
    };
    this.json.scenes[this.json.scene ?? 0].nodes.forEach(visit);
    return order;
  }

  meshNodes() {
    return this.json.nodes.map((node, index) => (node.mesh === undefined ? null : index)).filter(index => index !== null);
  }

  // The decoded index stream of a compressed TRIANGLES view, cached.
  decodedIndexView(viewIndex) {
    if (!this.decodedIndexViews.has(viewIndex)) {
      const view = this.json.bufferViews[viewIndex];
      const extension = view.extensions[MESHOPT];
      const decoded = new Uint8Array(extension.count * extension.byteStride);
      const source = this.binary.subarray(extension.byteOffset, extension.byteOffset + extension.byteLength);
      MeshoptDecoder.decodeGltfBuffer(decoded, extension.count, extension.byteStride, source, extension.mode, extension.filter ?? 'NONE');
      this.decodedIndexViews.set(viewIndex, decoded);
    }
    return this.decodedIndexViews.get(viewIndex);
  }

  isIndexView(viewIndex) {
    return this.json.bufferViews[viewIndex].extensions?.[MESHOPT]?.mode === 'TRIANGLES';
  }

  // Identifies a texture by what it shows: the bytes of its image and its sampler, so equal textures match across the parts.
  textureKey(oldTexture) {
    const texture = this.json.textures[oldTexture];
    const view = this.json.bufferViews[this.json.images[texture.source].bufferView];
    const start = view.byteOffset ?? 0;
    const hash = createHash('sha1');
    hash.update(this.binary.subarray(start, start + view.byteLength));
    hash.update(JSON.stringify(this.json.samplers?.[texture.sampler] ?? null));
    return hash.digest('hex').slice(0, 16);
  }

  // The part holding exactly these nodes (mesh-carrying nodes) plus their ancestors; returns { json, binary }.
  // `keepPrimitive(meshIndex, primitive)` picks the primitives of each mesh that this part draws; a node left with none is dropped.
  // `share.keys` are the texture keys that more than one part uses. This part tags them with extras.sharedTexture; when
  // `share.stripImages` is set it also swaps their images for the stand-in, so the bytes travel in the first part only.
  extract(requestedNodeIndices, keepPrimitive = () => true, share = { keys: new Set(), stripImages: false }) {
    const source = this.json;
    const meshNodeIndices = requestedNodeIndices.filter(index => source.meshes[source.nodes[index].mesh].primitives.some(primitive => keepPrimitive(source.nodes[index].mesh, primitive)));
    const keptNodes = new Set();
    const keepWithAncestors = nodeIndex => {
      for (let current = nodeIndex; current !== undefined; current = this.parentOf.get(current)) keptNodes.add(current);
    };
    const skinOrder = [...new Set(meshNodeIndices.map(index => source.nodes[index].skin).filter(skin => skin !== undefined))].sort((a, b) => a - b);
    const skinMap = new Map(skinOrder.map((oldIndex, newIndex) => [oldIndex, newIndex]));
    for (const nodeIndex of meshNodeIndices) keepWithAncestors(nodeIndex);
    for (const oldSkin of skinOrder) {
      for (const joint of source.skins[oldSkin].joints) keepWithAncestors(joint);
      if (source.skins[oldSkin].skeleton !== undefined) keepWithAncestors(source.skins[oldSkin].skeleton);
    }
    const nodeOrder = [...keptNodes].sort((a, b) => a - b);
    const nodeMap = new Map(nodeOrder.map((oldIndex, newIndex) => [oldIndex, newIndex]));

    const meshOrder = [...new Set(meshNodeIndices.map(index => source.nodes[index].mesh))].sort((a, b) => a - b);
    const meshMap = new Map(meshOrder.map((oldIndex, newIndex) => [oldIndex, newIndex]));
    const accessorOrder = [];
    const accessorMap = new Map();
    const materialOrder = [];
    const addAccessor = oldIndex => {
      if (oldIndex === undefined) return undefined;
      if (!accessorMap.has(oldIndex)) {
        accessorMap.set(oldIndex, accessorOrder.length);
        accessorOrder.push(oldIndex);
      }
      return accessorMap.get(oldIndex);
    };
    const materialMap = new Map();
    const meshes = meshOrder.map(oldMesh => {
      const mesh = structuredClone(source.meshes[oldMesh]);
      mesh.primitives = mesh.primitives.filter(primitive => keepPrimitive(oldMesh, primitive));
      for (const primitive of mesh.primitives) {
        if (primitive.targets || primitive.extensions) throw new Error('The splitter does not handle morph targets or primitive extensions.');
        primitive.indices = addAccessor(primitive.indices);
        for (const [name, accessor] of Object.entries(primitive.attributes)) primitive.attributes[name] = addAccessor(accessor);
        if (primitive.material !== undefined) {
          if (!materialMap.has(primitive.material)) {
            materialMap.set(primitive.material, materialOrder.length);
            materialOrder.push(primitive.material);
          }
          primitive.material = materialMap.get(primitive.material);
        }
      }
      return mesh;
    });
    // GPU instancing keeps its per-instance transforms in accessors of their own.
    const instancingOf = nodeIndex => source.nodes[nodeIndex].extensions?.EXT_mesh_gpu_instancing;
    const instancingAccessors = new Map();
    for (const nodeIndex of meshNodeIndices) {
      const instancing = instancingOf(nodeIndex);
      if (instancing) instancingAccessors.set(nodeIndex, Object.fromEntries(Object.entries(instancing.attributes).map(([name, accessor]) => [name, addAccessor(accessor)])));
    }
    const skins = skinOrder.map(oldSkin => {
      const skin = structuredClone(source.skins[oldSkin]);
      skin.joints = skin.joints.map(joint => nodeMap.get(joint));
      if (skin.skeleton !== undefined) skin.skeleton = nodeMap.get(skin.skeleton);
      skin.inverseBindMatrices = addAccessor(skin.inverseBindMatrices);
      return skin;
    });

    const textureOrder = [];
    const textureMap = new Map();
    for (const oldMaterial of materialOrder) {
      const found = new Set();
      collectTextureIndices(source.materials[oldMaterial], found);
      for (const texture of [...found].sort((a, b) => a - b)) {
        if (!textureMap.has(texture)) {
          textureMap.set(texture, textureOrder.length);
          textureOrder.push(texture);
        }
      }
    }
    const materials = materialOrder.map(oldMaterial => remapTextureIndices(structuredClone(source.materials[oldMaterial]), textureMap));

    const imageOrder = [];
    const imageMap = new Map();
    const samplerOrder = [];
    const samplerMap = new Map();
    const textureKeys = textureOrder.map(oldTexture => this.textureKey(oldTexture));
    const textures = textureOrder.map((oldTexture, position) => {
      const texture = structuredClone(source.textures[oldTexture]);
      if (texture.extensions) throw new Error('The splitter does not handle texture extensions.');
      let imageSource = texture.source;
      if (share.keys.has(textureKeys[position])) {
        texture.extras = { ...texture.extras, sharedTexture: textureKeys[position] };
        if (share.stripImages) imageSource = STAND_IN;
      }
      if (!imageMap.has(imageSource)) {
        imageMap.set(imageSource, imageOrder.length);
        imageOrder.push(imageSource);
      }
      texture.source = imageMap.get(imageSource);
      if (texture.sampler !== undefined) {
        if (!samplerMap.has(texture.sampler)) {
          samplerMap.set(texture.sampler, samplerOrder.length);
          samplerOrder.push(texture.sampler);
        }
        texture.sampler = samplerMap.get(texture.sampler);
      }
      return texture;
    });

    // Buffer views: images copy whole, attribute streams copy whole, index streams are rebuilt from the kept accessors.
    const output = { views: [], binaryChunks: [], binaryLength: 0, fallbackLength: 0 };
    const appendBinary = bytes => {
      const offset = output.binaryLength;
      output.binaryChunks.push(Buffer.from(bytes));
      const padding = (4 - (bytes.length % 4)) % 4;
      if (padding) output.binaryChunks.push(Buffer.alloc(padding));
      output.binaryLength += bytes.length + padding;
      return offset;
    };
    const viewMap = new Map();
    const copyView = oldView => {
      if (viewMap.has(oldView)) return viewMap.get(oldView);
      const view = structuredClone(source.bufferViews[oldView]);
      const extension = view.extensions?.[MESHOPT];
      if (extension) {
        extension.byteOffset = appendBinary(this.binary.subarray(extension.byteOffset, extension.byteOffset + extension.byteLength));
        extension.buffer = 0;
        view.buffer = 1;
        view.byteOffset = output.fallbackLength;
        output.fallbackLength += view.byteLength + ((4 - (view.byteLength % 4)) % 4);
      } else {
        view.byteOffset = appendBinary(this.binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
        view.buffer = 0;
      }
      output.views.push(view);
      viewMap.set(oldView, output.views.length - 1);
      return viewMap.get(oldView);
    };

    const indexAccessorsByView = new Map();
    for (const oldAccessor of accessorOrder) {
      const viewIndex = source.accessors[oldAccessor].bufferView;
      if (!this.isIndexView(viewIndex)) continue;
      if (!indexAccessorsByView.has(viewIndex)) indexAccessorsByView.set(viewIndex, []);
      indexAccessorsByView.get(viewIndex).push(oldAccessor);
    }
    const rebuiltIndexAccessors = new Map();
    for (const [viewIndex, oldAccessors] of indexAccessorsByView) {
      const sourceView = source.bufferViews[viewIndex];
      const stride = sourceView.extensions[MESHOPT].byteStride;
      const decoded = this.decodedIndexView(viewIndex);
      const slices = oldAccessors.map(oldAccessor => {
        const accessor = source.accessors[oldAccessor];
        const start = accessor.byteOffset ?? 0;
        return decoded.subarray(start, start + accessor.count * componentBytes(accessor.componentType) * TYPE_WIDTH[accessor.type]);
      });
      const joined = new Uint8Array(slices.reduce((total, slice) => total + slice.length, 0));
      let cursor = 0;
      const offsets = slices.map(slice => {
        joined.set(slice, cursor);
        cursor += slice.length;
        return cursor - slice.length;
      });
      const indexCount = joined.length / stride;
      const encoded = MeshoptEncoder.encodeIndexBuffer(joined, indexCount, stride);
      const view = structuredClone(sourceView);
      view.extensions[MESHOPT] = { ...view.extensions[MESHOPT], buffer: 0, byteOffset: appendBinary(encoded), byteLength: encoded.length, count: indexCount };
      view.buffer = 1;
      view.byteOffset = output.fallbackLength;
      view.byteLength = joined.length;
      output.fallbackLength += joined.length + ((4 - (joined.length % 4)) % 4);
      output.views.push(view);
      const newViewIndex = output.views.length - 1;
      oldAccessors.forEach((oldAccessor, position) => rebuiltIndexAccessors.set(oldAccessor, { bufferView: newViewIndex, byteOffset: offsets[position] }));
    }

    const accessors = accessorOrder.map(oldAccessor => {
      const accessor = structuredClone(source.accessors[oldAccessor]);
      if (accessor.sparse) throw new Error('The splitter does not handle sparse accessors.');
      const rebuilt = rebuiltIndexAccessors.get(oldAccessor);
      if (rebuilt) {
        accessor.bufferView = rebuilt.bufferView;
        accessor.byteOffset = rebuilt.byteOffset;
        if (!accessor.byteOffset) delete accessor.byteOffset;
      } else {
        accessor.bufferView = copyView(accessor.bufferView);
      }
      return accessor;
    });
    const images = imageOrder.map(oldImage => {
      if (oldImage === STAND_IN) {
        const view = { buffer: 0, byteOffset: appendBinary(STAND_IN_IMAGE), byteLength: STAND_IN_IMAGE.length };
        output.views.push(view);
        return { mimeType: 'image/png', bufferView: output.views.length - 1 };
      }
      const image = structuredClone(source.images[oldImage]);
      if (image.uri) throw new Error('The splitter does not handle images with a uri.');
      image.bufferView = copyView(image.bufferView);
      return image;
    });
    const samplers = samplerOrder.map(oldSampler => structuredClone(source.samplers[oldSampler]));

    const nodes = nodeOrder.map(oldNode => {
      const node = structuredClone(source.nodes[oldNode]);
      if (node.mesh !== undefined) {
        if (meshNodeIndices.includes(oldNode)) {
          node.mesh = meshMap.get(node.mesh);
          if (instancingAccessors.has(oldNode)) node.extensions.EXT_mesh_gpu_instancing.attributes = instancingAccessors.get(oldNode);
          if (node.skin !== undefined) node.skin = skinMap.get(node.skin);
        } else {
          delete node.mesh;
          delete node.extensions?.EXT_mesh_gpu_instancing;
          delete node.skin;
        }
      }
      if (node.children) {
        node.children = node.children.filter(child => nodeMap.has(child)).map(child => nodeMap.get(child));
        if (!node.children.length) delete node.children;
      }
      return node;
    });
    const sceneRoots = (source.scenes[source.scene ?? 0].nodes).filter(root => nodeMap.has(root)).map(root => nodeMap.get(root));

    const keptNodeSet = new Set(meshNodeIndices);
    // Ranks as runs of consecutive values, [[first, count], ...]: a part keeps long stretches of the draw order.
    const partRankRuns = [];
    this.drawOrder.forEach((entry, rank) => {
      if (!keptNodeSet.has(entry.nodeIndex) || !keepPrimitive(source.nodes[entry.nodeIndex].mesh, entry.primitive)) return;
      const lastRun = partRankRuns.at(-1);
      if (lastRun && lastRun[0] + lastRun[1] === rank) lastRun[1] += 1;
      else partRankRuns.push([rank, 1]);
    });
    const json = {
      asset: source.asset,
      extensionsUsed: source.extensionsUsed,
      extensionsRequired: source.extensionsRequired,
      scene: 0,
      scenes: [{ ...source.scenes[source.scene ?? 0], nodes: sceneRoots, extras: { partRankRuns } }],
      nodes,
      meshes,
      materials,
      accessors,
      bufferViews: output.views,
      buffers: [{ byteLength: output.binaryLength }, { byteLength: output.fallbackLength, extensions: { [MESHOPT]: { fallback: true } } }],
    };
    if (skins.length) json.skins = skins;
    if (textures.length) json.textures = textures;
    if (images.length) json.images = images;
    if (samplers.length) json.samplers = samplers;
    return { json, binary: Buffer.concat(output.binaryChunks), textureKeys };
  }
}

// A flat (not run-length) Radiance file at a fraction of the size; each output texel averages the linear colour of its block.
function writePreviewSky(sourcePath, targetPath) {
  const { width, height, data } = parseRadianceHdr(readFileSync(sourcePath));
  const blockWidth = Math.floor(width / PREVIEW_SKY_WIDTH);
  const blockHeight = Math.floor(height / PREVIEW_SKY_HEIGHT);
  const header = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${PREVIEW_SKY_HEIGHT} +X ${PREVIEW_SKY_WIDTH}\n`, 'latin1');
  const pixels = Buffer.alloc(PREVIEW_SKY_WIDTH * PREVIEW_SKY_HEIGHT * 4);
  for (let row = 0; row < PREVIEW_SKY_HEIGHT; row++) {
    for (let column = 0; column < PREVIEW_SKY_WIDTH; column++) {
      const sum = [0, 0, 0];
      for (let blockRow = 0; blockRow < blockHeight; blockRow++) {
        for (let blockColumn = 0; blockColumn < blockWidth; blockColumn++) {
          const texel = ((row * blockHeight + blockRow) * width + column * blockWidth + blockColumn) * 3;
          for (let channel = 0; channel < 3; channel++) sum[channel] += data[texel + channel];
        }
      }
      const average = sum.map(value => value / (blockWidth * blockHeight));
      const brightest = Math.max(...average);
      const target = (row * PREVIEW_SKY_WIDTH + column) * 4;
      if (brightest < 1e-32) continue;
      const exponent = Math.floor(Math.log2(brightest)) + 1;
      const scale = 256 / 2 ** exponent;
      for (let channel = 0; channel < 3; channel++) pixels[target + channel] = Math.min(255, Math.round(average[channel] * scale));
      pixels[target + 3] = exponent + 128;
    }
  }
  const file = Buffer.concat([header, pixels]);
  writeFileSync(targetPath, file);
  const check = parseRadianceHdr(file);
  if (check.width !== PREVIEW_SKY_WIDTH || check.height !== PREVIEW_SKY_HEIGHT) throw new Error('The preview sky does not parse back.');
  return file.length;
}

function parseArguments(argv) {
  const [worldId, ...rest] = argv;
  const options = { worldId, source: null, dryRun: false, list: false, first: null };
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === '--source') options.source = rest[++index];
    else if (rest[index] === '--dry-run') options.dryRun = true;
    else if (rest[index] === '--first') options.first = rest[++index].split(',');
    else if (rest[index] === '--list') {
      options.list = true;
      options.dryRun = true;
    }
    else throw new Error(`Unknown argument ${rest[index]}.`);
  }
  if (!FIRST_PART_NODE_NAMES[worldId]) throw new Error(`Usage: split-showcase-glb.mjs <${Object.keys(FIRST_PART_NODE_NAMES).join('|')}> --source <full.glb> [--dry-run]`);
  if (!options.source) throw new Error('Pass --source <full.glb>: the world as one GLB (see the comment at the top of this script).');
  return options;
}

const options = parseArguments(process.argv.slice(2));
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const world = new SourceWorld(readFileSync(options.source));
const firstPatterns = options.first ?? FIRST_PART_NODE_NAMES[options.worldId];
const isFirstName = (name = '') => firstPatterns.some(pattern => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern));
const allMeshNodes = world.meshNodes();
// Skinned parts always load with the first part: the renderer cannot add a skinned part to a scene that is already drawing.
const firstMeshes = new Set(allMeshNodes
  .filter(index => isFirstName(world.json.nodes[index].name) || world.json.nodes[index].skin !== undefined)
  .map(index => world.json.nodes[index].mesh));
const firstNodes = allMeshNodes.filter(index => firstMeshes.has(world.json.nodes[index].mesh));
const restNodes = allMeshNodes.filter(index => !firstMeshes.has(world.json.nodes[index].mesh));
if (!firstNodes.length) throw new Error('No node matches the first part names.');
// A hero mesh can hand its fine detail (by material name) to the rest, so the first part stays small.
const laterMaterials = new Set(LATER_MATERIAL_NAMES[options.worldId] ?? []);
const isLaterPrimitive = primitive => laterMaterials.has(world.json.materials[primitive.material]?.name);
const keepInFirst = (mesh, primitive) => !isLaterPrimitive(primitive);
const keepInRest = (mesh, primitive) => !firstMeshes.has(mesh) || isLaterPrimitive(primitive);
// A texture both parts use is stored in the first part only; the rest takes it by key once the first part has decoded it.
const firstTextureKeys = new Set(world.extract(firstNodes, keepInFirst).textureKeys);
const sharedKeys = new Set(world.extract([...firstNodes, ...restNodes], keepInRest).textureKeys.filter(key => firstTextureKeys.has(key)));
const firstPart = world.extract(firstNodes, keepInFirst, { keys: sharedKeys, stripImages: false });
const restPart = world.extract([...firstNodes, ...restNodes], keepInRest, { keys: sharedKeys, stripImages: true });
// Every image's bytes must travel once across the parts; this names any that still travel twice.
function imageHashes({ json, binary }) {
  return new Map((json.images ?? []).map(image => {
    const view = json.bufferViews[image.bufferView];
    const bytes = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    return [createHash('sha1').update(bytes).digest('hex'), bytes.length];
  }));
}
const firstImages = imageHashes(firstPart);
const duplicatedImages = [...imageHashes(restPart)].filter(([hash, length]) => firstImages.has(hash) && length > STAND_IN_IMAGE.length);
if (duplicatedImages.length) {
  const bytes = duplicatedImages.reduce((total, [, length]) => total + length, 0);
  console.warn(`${options.worldId}: ${duplicatedImages.length} images (${bytes} bytes) are stored in both parts.`);
}
const first = writeGlb(firstPart.json, firstPart.binary);
const rest = writeGlb(restPart.json, restPart.binary);
console.log(`${options.worldId}: first ${first.length} bytes (${firstNodes.length} nodes), rest ${rest.length} bytes (${restNodes.length} nodes), source ${readFileSync(options.source).length} bytes, ${sharedKeys.size} shared textures`);
if (!options.dryRun) {
  const directory = join(SHOWCASE_DIRECTORY, options.worldId);
  writeFileSync(join(directory, 'scene.glb'), first);
  writeFileSync(join(directory, 'scene.rest.glb'), rest);
  const previewBytes = writePreviewSky(join(directory, 'sky.hdr'), join(directory, 'sky.preview.hdr'));
  console.log(`wrote scene.glb, scene.rest.glb and sky.preview.hdr (${previewBytes} bytes)`);
  // The description names the parts: "glb" is the first, "glbRest" the others, "hdriPreview" the small sky.
  const descriptionPath = join(directory, 'scene.json');
  const description = readFileSync(descriptionPath, 'utf8');
  if (!description.includes('"glbRest"')) {
    // The files use CRLF line endings; the lines added match whatever the "glb" line uses.
    const staged = description.replace(/^([ \t]*)"glb": "([^"]*)",(\r?\n)/m, (match, indent, glbPath, newline) => (
      `${match}${indent}"glbRest": ["${glbPath.replace(/scene\.glb$/, 'scene.rest.glb')}"],${newline}${indent}"hdriPreview": "${glbPath.replace(/scene\.glb$/, 'sky.preview.hdr')}",${newline}`
    ));
    if (staged === description) throw new Error('scene.json has no "glb" line to extend.');
    writeFileSync(descriptionPath, staged);
  }
}
if (options.list) {
  // Helps to choose the first part: the size of each named node's mesh group (all nodes sharing its mesh) as a GLB of its own.
  const sizeByName = new Map();
  for (const index of allMeshNodes) {
    const name = world.json.nodes[index].name;
    if (sizeByName.has(name)) continue;
    const sameMesh = allMeshNodes.filter(other => world.json.nodes[other].mesh === world.json.nodes[index].mesh);
    sizeByName.set(name, `${writeGlb(...Object.values(world.extract(sameMesh))).length} bytes, ${sameMesh.length} nodes`);
  }
  for (const [name, size] of sizeByName) console.log(`${name}: ${size}`);
}
