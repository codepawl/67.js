// Surface and sky shading for the path tracer: the environment map as a light source, and a layered surface model
// (diffuse, GGX specular with metals, a clear coat, and glass) that matches the Principled BSDF settings of a part.

const TWO_PI = 2 * Math.PI;
const MINIMUM_ALPHA = 1e-3;
// Below this GGX width a lobe is a mirror for every practical purpose, so its normal is the surface normal.
const MIRROR_ALPHA = 2e-3;
const DIELECTRIC_COAT_REFLECTANCE = 0.04;

export function luminance(red, green, blue) {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

// ---- Environment map ----

/** Radiance toward `direction` (world space), bilinear, written into `out`. */
export function environmentRadiance(environment, directionX, directionY, directionZ, out) {
  const { width, height, channels, data, intensity, cosine, sine } = environment;
  const mapX = cosine * directionX - sine * directionZ;
  const mapZ = sine * directionX + cosine * directionZ;
  const column = (Math.atan2(mapX, -mapZ) / TWO_PI + 0.5) * width - 0.5;
  const row = Math.acos(Math.max(-1, Math.min(1, directionY))) / Math.PI * height - 0.5;
  const left = Math.floor(column);
  const top = Math.floor(row);
  const shareX = column - left;
  const shareY = row - top;
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  for (let corner = 0; corner < 4; corner++) {
    const cornerColumn = ((left + (corner & 1)) % width + width) % width;
    const cornerRow = Math.max(0, Math.min(height - 1, top + (corner >> 1)));
    const weight = ((corner & 1) ? shareX : 1 - shareX) * ((corner >> 1) ? shareY : 1 - shareY);
    const base = (cornerRow * width + cornerColumn) * channels;
    out[0] += weight * data[base] * intensity;
    out[1] += weight * data[base + 1] * intensity;
    out[2] += weight * data[base + 2] * intensity;
  }
}

function firstIndexAbove(cumulative, start, end, target) {
  let low = start;
  let high = end - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cumulative[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Probability density, per steradian, of drawing the direction that falls in the map pixel of `direction`. */
export function environmentPdf(environment, directionX, directionY, directionZ) {
  const { width, height, channels, data, cosine, sine, total } = environment;
  const mapX = cosine * directionX - sine * directionZ;
  const mapZ = sine * directionX + cosine * directionZ;
  const column = Math.min(width - 1, Math.floor((Math.atan2(mapX, -mapZ) / TWO_PI + 0.5) * width));
  const polar = Math.acos(Math.max(-1, Math.min(1, directionY)));
  const row = Math.min(height - 1, Math.floor(polar / Math.PI * height));
  const sinePolar = Math.max(Math.sin(polar), 1e-6);
  const rowWeight = Math.sin(Math.PI * (row + 0.5) / height);
  const base = (row * width + column) * channels;
  const weight = (luminance(data[base], data[base + 1], data[base + 2]) + 1e-6) * rowWeight;
  return weight / total * width * height / (TWO_PI * Math.PI * sinePolar);
}

/** Draws a direction in proportion to the map's light; returns its pdf and writes the direction into `out`. */
export function sampleEnvironment(environment, rowUnit, columnUnit, columnJitter, rowJitter, out) {
  const { width, height, cosine, sine, rowCumulative, pixelCumulative, total } = environment;
  const row = firstIndexAbove(rowCumulative, 0, height, rowUnit * total);
  const rowBase = row * width;
  const rowTotal = pixelCumulative[rowBase + width - 1];
  const column = firstIndexAbove(pixelCumulative, rowBase, rowBase + width, columnUnit * rowTotal) - rowBase;
  const polar = Math.PI * (row + rowJitter) / height;
  const azimuth = ((column + columnJitter) / width - 0.5) * TWO_PI;
  const sinePolar = Math.sin(polar);
  const mapX = sinePolar * Math.sin(azimuth);
  const mapZ = -sinePolar * Math.cos(azimuth);
  out[0] = cosine * mapX + sine * mapZ;
  out[1] = Math.cos(polar);
  out[2] = -sine * mapX + cosine * mapZ;
  return environmentPdf(environment, out[0], out[1], out[2]);
}

// ---- Microfacet pieces ----

function ggxDistribution(alpha, cosineHalf) {
  const alphaSquared = alpha * alpha;
  const denominator = cosineHalf * cosineHalf * (alphaSquared - 1) + 1;
  return alphaSquared / (Math.PI * denominator * denominator);
}

function smithMasking(alpha, cosine) {
  const alphaSquared = alpha * alpha;
  const cosineSquared = cosine * cosine;
  return 2 * cosine / (cosine + Math.sqrt(alphaSquared + (1 - alphaSquared) * cosineSquared));
}

function schlick(reflectanceAtNormal, cosine) {
  const weight = (1 - Math.min(Math.max(cosine, 0), 1)) ** 5;
  return reflectanceAtNormal + (1 - reflectanceAtNormal) * weight;
}

/** Heitz's visible-normal sampling: a half vector in the local frame (z along the normal) for a view in the same frame. */
function sampleVisibleNormal(viewX, viewY, viewZ, alpha, firstUnit, secondUnit, out) {
  let stretchedX = alpha * viewX;
  let stretchedY = alpha * viewY;
  const stretchedZ = viewZ;
  const stretchedLength = Math.hypot(stretchedX, stretchedY, stretchedZ);
  stretchedX /= stretchedLength;
  stretchedY /= stretchedLength;
  const heightAxis = stretchedZ / stretchedLength;
  const planeLength = Math.hypot(stretchedX, stretchedY);
  const tangentX = planeLength > 0 ? -stretchedY / planeLength : 1;
  const tangentY = planeLength > 0 ? stretchedX / planeLength : 0;
  const bitangentX = -heightAxis * (planeLength > 0 ? stretchedX / planeLength : 0);
  const bitangentY = -heightAxis * (planeLength > 0 ? stretchedY / planeLength : 0);
  const bitangentZ = planeLength;
  const radius = Math.sqrt(firstUnit);
  const angle = TWO_PI * secondUnit;
  const diskX = radius * Math.cos(angle);
  let diskY = radius * Math.sin(angle);
  const blend = 0.5 * (1 + heightAxis);
  diskY = (1 - blend) * Math.sqrt(1 - diskX * diskX) + blend * diskY;
  const lift = Math.sqrt(Math.max(0, 1 - diskX * diskX - diskY * diskY));
  const normalX = diskX * tangentX + diskY * bitangentX + lift * stretchedX;
  const normalY = diskX * tangentY + diskY * bitangentY + lift * stretchedY;
  const normalZ = diskY * bitangentZ + lift * heightAxis;
  const unstretchedX = alpha * normalX;
  const unstretchedY = alpha * normalY;
  const unstretchedZ = Math.max(0, normalZ);
  const length = Math.hypot(unstretchedX, unstretchedY, unstretchedZ);
  out[0] = unstretchedX / length;
  out[1] = unstretchedY / length;
  out[2] = unstretchedZ / length;
}

export function roughnessToAlpha(roughness) {
  return Math.max(roughness * roughness, MINIMUM_ALPHA);
}

// ---- Frames ----

/** Fills `frame` with an orthonormal basis around `normal`: tangent, bitangent, normal. */
export function buildFrame(normal, frame) {
  const helperIsX = Math.abs(normal[0]) < 0.9;
  const helperX = helperIsX ? 1 : 0;
  const helperY = helperIsX ? 0 : 1;
  let tangentX = normal[1] * 0 - normal[2] * helperY;
  let tangentY = normal[2] * helperX - normal[0] * 0;
  let tangentZ = normal[0] * helperY - normal[1] * helperX;
  const tangentLength = Math.hypot(tangentX, tangentY, tangentZ);
  tangentX /= tangentLength;
  tangentY /= tangentLength;
  tangentZ /= tangentLength;
  frame[0] = tangentX;
  frame[1] = tangentY;
  frame[2] = tangentZ;
  frame[3] = normal[1] * tangentZ - normal[2] * tangentY;
  frame[4] = normal[2] * tangentX - normal[0] * tangentZ;
  frame[5] = normal[0] * tangentY - normal[1] * tangentX;
  frame[6] = normal[0];
  frame[7] = normal[1];
  frame[8] = normal[2];
}

function localToWorld(frame, x, y, z, out) {
  out[0] = frame[0] * x + frame[3] * y + frame[6] * z;
  out[1] = frame[1] * x + frame[4] * y + frame[7] * z;
  out[2] = frame[2] * x + frame[5] * y + frame[8] * z;
}

function worldToLocal(frame, x, y, z, out) {
  out[0] = frame[0] * x + frame[1] * y + frame[2] * z;
  out[1] = frame[3] * x + frame[4] * y + frame[5] * z;
  out[2] = frame[6] * x + frame[7] * y + frame[8] * z;
}

const LOCAL_VIEW = new Float64Array(3);
const LOCAL_HALF = new Float64Array(3);
const LOCAL_LIGHT = new Float64Array(3);

// ---- The layered surface ----

export function createSurface() {
  return {
    frame: new Float64Array(9),
    view: new Float64Array(3),
    viewCosine: 0,
    diffuseColor: new Float64Array(3),
    specularNormalReflectance: new Float64Array(3),
    specularWeight: 1,
    specularAlpha: MINIMUM_ALPHA,
    coatWeight: 0,
    coatChance: 0,
    sampledCoat: false,
    coatAlpha: MINIMUM_ALPHA,
    diffuseChance: 1,
    // The diffuse light a part with subsurface sends through its random walk instead, and the Fresnel share it keeps.
    subsurfaceChance: 0,
    diffuseShare: 1,
    specularChance: 0,
    // Outputs of evaluate().
    value: new Float64Array(3),
    pdf: 0,
  };
}

/**
 * The share of light a dielectric's GGX specular layer reflects from a view direction (Karis's analytic fit of the
 * split-sum environment BRDF). A rough layer reflects far less than the mirror Fresnel term at a grazing view, so the
 * diffuse layer below keeps more of its light, as Cycles' Principled BSDF does.
 */
function dielectricSpecularAlbedo(normalReflectance, roughness, viewCosine) {
  const smoothness = 1 - roughness;
  const slope = Math.min(smoothness * smoothness, 2 ** (-9.28 * viewCosine)) * smoothness + (0.0425 - 0.0275 * roughness);
  const scale = 1.04 - 0.572 * roughness - 1.04 * slope;
  const offset = 1.04 * slope + 0.022 * roughness - 0.04;
  return Math.min(1, Math.max(0, normalReflectance * scale + offset));
}

/**
 * Sets the lobes of a hit. `view` points from the surface toward the viewer and `normal` faces it. A dielectric keeps
 * the light its reflection did not take, so the diffuse colour shrinks with the Fresnel term, and a clear coat takes
 * its share from both lobes below it.
 */
export function prepareSurface(surface, material, metallic, roughness, baseColor, normal, viewX, viewY, viewZ, clearcoat = material.clearcoat) {
  buildFrame(normal, surface.frame);
  surface.view[0] = viewX;
  surface.view[1] = viewY;
  surface.view[2] = viewZ;
  const viewCosine = Math.max(normal[0] * viewX + normal[1] * viewY + normal[2] * viewZ, 1e-4);
  surface.viewCosine = viewCosine;
  const ratio = (material.ior - 1) / (material.ior + 1);
  const dielectricNormalReflectance = ratio * ratio;
  const dielectricFresnel = dielectricSpecularAlbedo(dielectricNormalReflectance, roughness, viewCosine);
  surface.coatWeight = clearcoat > 0 ? clearcoat * schlick(DIELECTRIC_COAT_REFLECTANCE, viewCosine) : 0;
  const underCoat = 1 - surface.coatWeight;
  const diffuseShare = (1 - metallic) * (1 - dielectricFresnel) * underCoat;
  for (let channel = 0; channel < 3; channel++) {
    surface.diffuseColor[channel] = baseColor[channel] * diffuseShare;
    const normalReflectance = dielectricNormalReflectance * (1 - metallic) + baseColor[channel] * metallic;
    surface.specularNormalReflectance[channel] = normalReflectance;
  }
  const specularLuminance = luminance(surface.specularNormalReflectance[0], surface.specularNormalReflectance[1], surface.specularNormalReflectance[2]);
  surface.specularWeight = underCoat;
  surface.specularAlpha = roughnessToAlpha(roughness);
  surface.coatAlpha = roughnessToAlpha(material.clearcoatRoughness);
  const diffuseLuminance = luminance(surface.diffuseColor[0], surface.diffuseColor[1], surface.diffuseColor[2]);
  const specularChance = schlick(specularLuminance, viewCosine) * underCoat;
  const coatChance = surface.coatWeight;
  const sum = diffuseLuminance + specularChance + coatChance;
  surface.diffuseChance = sum > 0 ? diffuseLuminance / sum : 1;
  surface.subsurfaceChance = 0;
  surface.diffuseShare = diffuseShare;
  surface.specularChance = sum > 0 ? specularChance / sum : 0;
  surface.coatChance = sum > 0 ? coatChance / sum : 0;
}

/**
 * Moves `weight` of the diffuse lobe to the subsurface walk: the surface keeps the rest of the diffuse light, all of the
 * specular and the coat, and `subsurfaceChance` is the chance of taking the walk, drawn before sampleSurface().
 */
export function splitSubsurface(surface, weight) {
  surface.subsurfaceChance = surface.diffuseChance * weight;
  surface.diffuseChance -= surface.subsurfaceChance;
  for (let channel = 0; channel < 3; channel++) surface.diffuseColor[channel] *= 1 - weight;
}

/** A white Lambertian surface facing `normal`: where a subsurface walk leaves, the walk's throughput carries the colour. */
export function setWhiteDiffuse(surface, normal) {
  buildFrame(normal, surface.frame);
  surface.diffuseColor.fill(1);
  surface.diffuseChance = 1;
  surface.subsurfaceChance = 0;
  surface.specularChance = 0;
  surface.coatChance = 0;
  surface.coatWeight = 0;
}

function microfacetTerm(alpha, viewCosine, lightCosine, halfCosine) {
  return ggxDistribution(alpha, halfCosine) * smithMasking(alpha, viewCosine) * smithMasking(alpha, lightCosine) / (4 * viewCosine * lightCosine);
}

/**
 * The surface's value (BSDF, without the cosine) and sampling density for a light direction, in `surface.value` and
 * `surface.pdf`. A mirror lobe reports zero, because a light sample can never hit it.
 */
export function evaluateSurface(surface, lightX, lightY, lightZ) {
  surface.value[0] = 0;
  surface.value[1] = 0;
  surface.value[2] = 0;
  surface.pdf = 0;
  const { frame, view, viewCosine } = surface;
  const lightCosine = frame[6] * lightX + frame[7] * lightY + frame[8] * lightZ;
  if (lightCosine <= 0) return;
  let halfX = view[0] + lightX;
  let halfY = view[1] + lightY;
  let halfZ = view[2] + lightZ;
  const halfLength = Math.hypot(halfX, halfY, halfZ) || 1;
  halfX /= halfLength;
  halfY /= halfLength;
  halfZ /= halfLength;
  const halfCosine = frame[6] * halfX + frame[7] * halfY + frame[8] * halfZ;
  const viewHalfCosine = Math.max(view[0] * halfX + view[1] * halfY + view[2] * halfZ, 0);
  surface.pdf += surface.diffuseChance * lightCosine / Math.PI;
  for (let channel = 0; channel < 3; channel++) surface.value[channel] += surface.diffuseColor[channel] / Math.PI;
  if (surface.specularChance > 0 && surface.specularAlpha > MIRROR_ALPHA) {
    const alpha = surface.specularAlpha;
    const term = microfacetTerm(alpha, viewCosine, lightCosine, halfCosine) * surface.specularWeight;
    for (let channel = 0; channel < 3; channel++) surface.value[channel] += schlick(surface.specularNormalReflectance[channel], viewHalfCosine) * term;
    surface.pdf += surface.specularChance * smithMasking(alpha, viewCosine) * ggxDistribution(alpha, halfCosine) / (4 * viewCosine);
  }
  if (surface.coatChance > 0 && surface.coatAlpha > MIRROR_ALPHA) {
    const alpha = surface.coatAlpha;
    const reflectance = schlick(DIELECTRIC_COAT_REFLECTANCE, viewHalfCosine) * microfacetTerm(alpha, viewCosine, lightCosine, halfCosine) * (surface.coatWeight / Math.max(schlick(DIELECTRIC_COAT_REFLECTANCE, viewCosine), 1e-6));
    for (let channel = 0; channel < 3; channel++) surface.value[channel] += reflectance;
    surface.pdf += surface.coatChance * smithMasking(alpha, viewCosine) * ggxDistribution(alpha, halfCosine) / (4 * viewCosine);
  }
}

function reflectAbout(halfX, halfY, halfZ, viewX, viewY, viewZ, out) {
  const projection = 2 * (viewX * halfX + viewY * halfY + viewZ * halfZ);
  out[0] = projection * halfX - viewX;
  out[1] = projection * halfY - viewY;
  out[2] = projection * halfZ - viewZ;
}

/**
 * Draws the next direction of a path. Mirror lobes are followed exactly: the result's `mirror` is true and
 * `weight` is already the throughput factor. Other lobes leave `weight` to the caller, from evaluateSurface().
 */
export function sampleSurface(surface, lobeUnit, firstUnit, secondUnit, out) {
  const { frame, view } = surface;
  if (lobeUnit < surface.diffuseChance) {
    const radius = Math.sqrt(firstUnit);
    const angle = TWO_PI * secondUnit;
    localToWorld(frame, radius * Math.cos(angle), radius * Math.sin(angle), Math.sqrt(Math.max(0, 1 - firstUnit)), out);
    return false;
  }
  const isCoat = lobeUnit >= surface.diffuseChance + surface.specularChance;
  surface.sampledCoat = isCoat;
  const alpha = isCoat ? surface.coatAlpha : surface.specularAlpha;
  worldToLocal(frame, view[0], view[1], view[2], LOCAL_VIEW);
  if (alpha <= MIRROR_ALPHA) {
    out[0] = 2 * surface.viewCosine * frame[6] - view[0];
    out[1] = 2 * surface.viewCosine * frame[7] - view[1];
    out[2] = 2 * surface.viewCosine * frame[8] - view[2];
    return true;
  }
  sampleVisibleNormal(LOCAL_VIEW[0], LOCAL_VIEW[1], LOCAL_VIEW[2], alpha, firstUnit, secondUnit, LOCAL_HALF);
  reflectAbout(LOCAL_HALF[0], LOCAL_HALF[1], LOCAL_HALF[2], LOCAL_VIEW[0], LOCAL_VIEW[1], LOCAL_VIEW[2], LOCAL_LIGHT);
  localToWorld(frame, LOCAL_LIGHT[0], LOCAL_LIGHT[1], LOCAL_LIGHT[2], out);
  return false;
}

/** The throughput factor of a followed mirror lobe: its Fresnel share over the chance of having picked it. */
export function mirrorWeight(surface, out) {
  if (surface.sampledCoat) {
    out[0] = out[1] = out[2] = surface.coatWeight / surface.coatChance;
    return;
  }
  for (let channel = 0; channel < 3; channel++) {
    out[channel] = schlick(surface.specularNormalReflectance[channel], surface.viewCosine) * surface.specularWeight / surface.specularChance;
  }
}

// ---- Glass ----

function dielectricFresnel(cosineIncident, relativeIndex) {
  const sineSquared = relativeIndex * relativeIndex * (1 - cosineIncident * cosineIncident);
  if (sineSquared >= 1) return 1;
  const cosineTransmitted = Math.sqrt(1 - sineSquared);
  const parallel = (relativeIndex * cosineIncident - cosineTransmitted) / (relativeIndex * cosineIncident + cosineTransmitted);
  const perpendicular = (cosineIncident - relativeIndex * cosineTransmitted) / (cosineIncident + relativeIndex * cosineTransmitted);
  return 0.5 * (parallel * parallel + perpendicular * perpendicular);
}

/**
 * A dielectric interface: reflects with the Fresnel chance and refracts otherwise, through a GGX normal for rough
 * glass. `normal` faces the viewer. Writes the new direction into `out` and returns false when it ends inside the
 * surface (the path is dropped).
 */
export function sampleGlass(normal, viewX, viewY, viewZ, entering, ior, alpha, selectionUnit, firstUnit, secondUnit, out) {
  const frame = GLASS_FRAME;
  buildFrame(normal, frame);
  let halfX = normal[0];
  let halfY = normal[1];
  let halfZ = normal[2];
  if (alpha > MIRROR_ALPHA) {
    worldToLocal(frame, viewX, viewY, viewZ, LOCAL_VIEW);
    sampleVisibleNormal(LOCAL_VIEW[0], LOCAL_VIEW[1], LOCAL_VIEW[2], alpha, firstUnit, secondUnit, LOCAL_HALF);
    localToWorld(frame, LOCAL_HALF[0], LOCAL_HALF[1], LOCAL_HALF[2], GLASS_HALF);
    halfX = GLASS_HALF[0];
    halfY = GLASS_HALF[1];
    halfZ = GLASS_HALF[2];
  }
  const relativeIndex = entering ? 1 / ior : ior;
  const cosineIncident = Math.max(viewX * halfX + viewY * halfY + viewZ * halfZ, 1e-6);
  const reflectChance = dielectricFresnel(cosineIncident, relativeIndex);
  if (selectionUnit < reflectChance) {
    reflectAbout(halfX, halfY, halfZ, viewX, viewY, viewZ, out);
    return out[0] * normal[0] + out[1] * normal[1] + out[2] * normal[2] > 0;
  }
  const cosineTransmitted = Math.sqrt(Math.max(0, 1 - relativeIndex * relativeIndex * (1 - cosineIncident * cosineIncident)));
  const bend = relativeIndex * cosineIncident - cosineTransmitted;
  out[0] = bend * halfX - relativeIndex * viewX;
  out[1] = bend * halfY - relativeIndex * viewY;
  out[2] = bend * halfZ - relativeIndex * viewZ;
  return out[0] * normal[0] + out[1] * normal[1] + out[2] * normal[2] < 0;
}

const GLASS_FRAME = new Float64Array(9);
const GLASS_HALF = new Float64Array(3);
