// Lets renderer.updateParts skip the material checks for a part whose material still holds the values that passed them.
// The fields are written out one by one: a loop over field names reads each one through a megamorphic keyed load, which costs
// more than the checks it saves. tests/material-snapshot.test.js keeps the lists in step with the renderer's material fields.

/** Material fields that the renderer compares with the batch a part was committed to. */
export const SNAPSHOT_VALUE_FIELDS = Object.freeze(['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap', 'tag', 'alphaMode', 'alphaCutoff', 'opacity', 'doubleSided', 'occlusionStrength', 'moss', 'boxMapScale', 'boxMapAxis', 'lightMapScale', 'layerMaps', 'lightMask', 'clearcoat', 'clearcoatRoughness', 'transmission', 'thickness', 'ior', 'sheenRoughness', 'specular', 'anisotropy', 'anisotropyRotation', 'iridescence', 'iridescenceIor', 'iridescenceThickness', 'attenuationDistance', 'toon']);

/** Fields holding an array or descriptor, which can change in place. A material that sets one is never snapshotted. */
export const SNAPSHOT_REFERENCE_FIELDS = Object.freeze(['normalScale', 'mossColor', 'lightMap', 'attenuationColor', 'sheenColor', 'specularColor', 'subsurface', 'wear']);

function hasNoReferenceFields(material) {
  return material.normalScale === undefined &&
    material.mossColor === undefined &&
    material.lightMap === undefined &&
    material.attenuationColor === undefined &&
    material.sheenColor === undefined &&
    material.specularColor === undefined &&
    material.subsurface === undefined &&
    material.wear === undefined;
}

export class MaterialSnapshot {
  /** Null when the material sets an array-valued field. */
  static of(material) {
    return hasNoReferenceFields(material) ? new MaterialSnapshot(material) : null;
  }

  constructor(material) {
    this.map = material.map;
    this.normalMap = material.normalMap;
    this.metallicRoughnessMap = material.metallicRoughnessMap;
    this.occlusionMap = material.occlusionMap;
    this.emissiveMap = material.emissiveMap;
    this.tag = material.tag;
    this.alphaMode = material.alphaMode;
    this.alphaCutoff = material.alphaCutoff;
    this.opacity = material.opacity;
    this.doubleSided = material.doubleSided;
    this.occlusionStrength = material.occlusionStrength;
    this.moss = material.moss;
    this.boxMapScale = material.boxMapScale;
    this.boxMapAxis = material.boxMapAxis;
    this.lightMapScale = material.lightMapScale;
    this.layerMaps = material.layerMaps;
    this.lightMask = material.lightMask;
    this.clearcoat = material.clearcoat;
    this.clearcoatRoughness = material.clearcoatRoughness;
    this.transmission = material.transmission;
    this.thickness = material.thickness;
    this.ior = material.ior;
    this.sheenRoughness = material.sheenRoughness;
    this.specular = material.specular;
    this.anisotropy = material.anisotropy;
    this.anisotropyRotation = material.anisotropyRotation;
    this.iridescence = material.iridescence;
    this.iridescenceIor = material.iridescenceIor;
    this.iridescenceThickness = material.iridescenceThickness;
    this.attenuationDistance = material.attenuationDistance;
    this.toon = material.toon;
  }

  matches(material) {
    return hasNoReferenceFields(material) &&
      this.map === material.map &&
      this.normalMap === material.normalMap &&
      this.metallicRoughnessMap === material.metallicRoughnessMap &&
      this.occlusionMap === material.occlusionMap &&
      this.emissiveMap === material.emissiveMap &&
      this.tag === material.tag &&
      this.alphaMode === material.alphaMode &&
      this.alphaCutoff === material.alphaCutoff &&
      this.opacity === material.opacity &&
      this.doubleSided === material.doubleSided &&
      this.occlusionStrength === material.occlusionStrength &&
      this.moss === material.moss &&
      this.boxMapScale === material.boxMapScale &&
      this.boxMapAxis === material.boxMapAxis &&
      this.lightMapScale === material.lightMapScale &&
      this.layerMaps === material.layerMaps &&
      this.lightMask === material.lightMask &&
      this.clearcoat === material.clearcoat &&
      this.clearcoatRoughness === material.clearcoatRoughness &&
      this.transmission === material.transmission &&
      this.thickness === material.thickness &&
      this.ior === material.ior &&
      this.sheenRoughness === material.sheenRoughness &&
      this.specular === material.specular &&
      this.anisotropy === material.anisotropy &&
      this.anisotropyRotation === material.anisotropyRotation &&
      this.iridescence === material.iridescence &&
      this.iridescenceIor === material.iridescenceIor &&
      this.iridescenceThickness === material.iridescenceThickness &&
      this.attenuationDistance === material.attenuationDistance &&
      this.toon === material.toon;
  }
}
