// Scene description fields that only the Cook `cycles` kernel (and Cycles, through render-cycles.py) read:
//   area light `shape` ('rectangle', 'disk' or 'ellipse') and `spread` (radians, 0.0001 to pi),
//   material `alphaMode: 'blend'` with `opacity` below 1 (a transparent shadow, as a Principled alpha below 1 in Cycles).
// The rasterizer, the legacy kernel and the core bundle ignore them, so they are copied onto the trace scene here.
export const AREA_LIGHT_SHAPES = ['rectangle', 'disk', 'ellipse'];

function checkedShape(shape, label) {
  if (!AREA_LIGHT_SHAPES.includes(shape)) {
    throw new RangeError(`${label} shape must be one of ${AREA_LIGHT_SHAPES.join(', ')}, got ${JSON.stringify(shape)}.`);
  }
  return shape;
}

function checkedSpread(spread, label) {
  if (typeof spread !== 'number' || !Number.isFinite(spread) || spread < 0.0001 || spread > Math.PI) {
    throw new RangeError(`${label} spread must be between 0.0001 and pi radians, got ${spread}.`);
  }
  return spread;
}

export function applyCookOnlyFields(traceScene, parts, environment) {
  const areaLights = environment.areaLights ?? [];
  traceScene.lights.areas.forEach((resolvedLight, index) => {
    const label = `Area light ${index}`;
    const sourceLight = areaLights[index] ?? {};
    if (sourceLight.shape !== undefined) {
      resolvedLight.shape = checkedShape(sourceLight.shape, label);
    }
    if (sourceLight.spread !== undefined) {
      resolvedLight.spread = checkedSpread(sourceLight.spread, label);
    }
  });
  traceScene.materials.forEach((resolvedMaterial, index) => {
    const sourceMaterial = parts[index]?.material ?? {};
    const opacity = sourceMaterial.opacity;
    const isBlended = sourceMaterial.alphaMode === 'blend' && opacity >= 0 && opacity < 1;
    if (isBlended && !(resolvedMaterial.alphaCutoff > 0)) {
      resolvedMaterial.alphaMode = 'blend';
      resolvedMaterial.opacity = opacity;
    }
  });
  return traceScene;
}
