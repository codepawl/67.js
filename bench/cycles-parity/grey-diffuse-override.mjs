// A grey diffuse material for every part of an exported scene: the Cook side of Blender's view-layer material override.
// render-cycles.py --grey-diffuse builds the same material (GREY_DIFFUSE_ENTRY there), so both renderers shade one thing.

export const GREY_DIFFUSE_ALBEDO = 0.8;

export function createGreyDiffuseMaterial() {
  return {
    tag: 'surface',
    color: [GREY_DIFFUSE_ALBEDO, GREY_DIFFUSE_ALBEDO, GREY_DIFFUSE_ALBEDO],
    metallic: 0,
    roughness: 1,
    specular: 0,
    emission: 0,
  };
}

// Returns a copy of the scene description in which every material is the grey diffuse one and no mesh carries vertex
// colours, so textures, emission, transmission and colour attributes cannot change the shading. Lights stay as they are.
export function applyGreyDiffuseOverride(description) {
  if (!Array.isArray(description.materials) || !Array.isArray(description.geometries)) {
    throw new TypeError('applyGreyDiffuseOverride needs a scene description with materials and geometries arrays.');
  }
  return {
    ...description,
    materials: description.materials.map(() => createGreyDiffuseMaterial()),
    images: [],
    geometries: description.geometries.map((geometryEntry) => {
      const { colors, ...geometryWithoutColors } = geometryEntry;
      return geometryWithoutColors;
    }),
  };
}
