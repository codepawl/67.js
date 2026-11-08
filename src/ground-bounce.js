import { computeIrradianceCoefficients, createEnvironmentMap, evaluateIrradiance } from './environment.js'
import { CLOSED_ROOM_SHARE, closedRoomShare } from './closed-room.js'
import { worldBounds } from './probe-trace.js'

// The ground of a scene is its floor: a part that spans the scene (the same test as the automatic floor of agent scenes),
// is thin and is the lowest geometry. Its albedo comes from its material.
const GROUND_SPAN_SHARE = 0.9
const GROUND_THINNESS = 0.25
const GROUND_LOWEST_TOLERANCE = 1e-3
const GROUND_MAXIMUM_METALLIC = 0.5
// The display gamma stands for the sRGB curve: a mean albedo does not need its toe.
const DISPLAY_GAMMA = 2.2
const EXCLUDED_TAGS = new Set(['liquid', 'foam', 'unlit', 'fire', 'smoke', 'floor'])

function sceneBoundsOf(boundsList) {
  const minimum = [Infinity, Infinity, Infinity]
  const maximum = [-Infinity, -Infinity, -Infinity]
  for (const bounds of boundsList) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], bounds.minimum[axis])
      maximum[axis] = Math.max(maximum[axis], bounds.maximum[axis])
    }
  }
  return { minimum, maximum }
}

// The mean of a base-colour texture in linear space, found once per image. Null for an image that is not raw RGBA bytes.
const textureMeans = new WeakMap()

function textureMeanAlbedo(map) {
  const image = map.image
  if (!image?.data || !(image.width > 0) || image.data.length < image.width * image.height * 4) {
    return null
  }
  if (!textureMeans.has(image)) {
    const exponent = map.colorSpace === 'linear' ? 1 : DISPLAY_GAMMA
    const sums = [0, 0, 0]
    const pixelCount = image.width * image.height
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      for (let channel = 0; channel < 3; channel++) {
        sums[channel] += (image.data[pixel * 4 + channel] / 255) ** exponent
      }
    }
    textureMeans.set(image, sums.map(sum => sum / pixelCount))
  }
  return textureMeans.get(image)
}

function groundAlbedo(material) {
  const surface = !material.graph && !['blend', 'add'].includes(material.alphaMode) && !(material.transmission > 0) && !EXCLUDED_TAGS.has(material.tag)
  if (!surface || !Array.isArray(material.color) || (material.metallic ?? 0) > GROUND_MAXIMUM_METALLIC) {
    return null
  }
  const textureMean = material.map ? textureMeanAlbedo(material.map) : [1, 1, 1]
  if (!textureMean) {
    return null
  }
  return material.color.slice(0, 3).map((channel, index) => channel * textureMean[index] * (1 - (material.metallic ?? 0)))
}

/**
 * The floor of a scene as `{ albedo }`, or null: the lowest, thin part that spans the scene, when its surface is a plain
 * or textured, non-metal, opaque colour. Water, a procedural graph material and a scene without a floor give null. A
 * texture's albedo is its mean in linear space times the material colour.
 */
export function findGroundSurface(parts) {
  if (parts.length < 2) {
    return null
  }
  const boundsList = parts.map(part => worldBounds(part))
  const scene = sceneBoundsOf(boundsList)
  const widthX = scene.maximum[0] - scene.minimum[0]
  const widthZ = scene.maximum[2] - scene.minimum[2]
  for (const [index, bounds] of boundsList.entries()) {
    const partX = bounds.maximum[0] - bounds.minimum[0]
    const partZ = bounds.maximum[2] - bounds.minimum[2]
    const partHeight = bounds.maximum[1] - bounds.minimum[1]
    const spansScene = partX >= GROUND_SPAN_SHARE * widthX && partZ >= GROUND_SPAN_SHARE * widthZ
    const isThin = partHeight <= GROUND_THINNESS * Math.max(partX, partZ)
    const isLowest = bounds.minimum[1] <= scene.minimum[1] + GROUND_LOWEST_TOLERANCE
    if (spansScene && isThin && isLowest) {
      const albedo = groundAlbedo(parts[index].material)
      return albedo ? { albedo } : null
    }
  }
  return null
}

/**
 * Returns the environment map with an `irradianceSource`: a copy whose lower half is the light a flat ground sends back
 * up, albedo times the sun and the sky that reach it, over pi. Only the diffuse light reads that copy, so a wall, a figure
 * or a roof gets ground bounce at no cost per frame, while the background and the reflections still show the original sky. The ground is taken as unshadowed, level (y up) and
 * infinite, so a scene with a small or mostly shaded floor should give a smaller albedo.
 *
 * `albedo` is the ground's linear colour, `keyColor` and `lightDirection` are the environment's sun (direction
 * towards the sun, any length), as `environment` takes them.
 */
export function withGroundBounce(map, { albedo, keyColor = [0, 0, 0], lightDirection = [0, 1, 0] }) {
  const { width, height, channels, data, intensity } = map
  const sunLength = Math.hypot(...lightDirection)
  const sunOnGround = Math.max(lightDirection[1] / sunLength, 0)
  const skyOnGround = evaluateIrradiance(computeIrradianceCoefficients(map), [0, 1, 0])
  const groundRadiance = albedo.map((channel, index) => {
    const sun = intensity > 0 ? (keyColor[index] * sunOnGround) / (Math.PI * intensity) : 0
    return channel * (sun + skyOnGround[index])
  })
  const bounced = new Float32Array(data)
  for (let row = Math.ceil(height / 2); row < height; row++) {
    for (let column = 0; column < width; column++) {
      const offset = (row * width + column) * channels
      for (let index = 0; index < 3; index++) bounced[offset + index] = groundRadiance[index]
    }
  }
  return Object.freeze({ ...map, irradianceSource: createEnvironmentMap({ ...map, data: bounced }) })
}

// The renderer keys its prefiltered copy of a map on the map object, so the same inputs must return the same object.
const cache = new WeakMap()

function isDrawnWithBakedLight(parts) {
  return parts.some(part => part.material?.lightMap || part.material?.irradianceGrid)
}

function isClosedRoom(parts) {
  const share = closedRoomShare(parts, new Map(parts.map(part => [part.name, part.matrix])))
  return share !== null && share >= CLOSED_ROOM_SHARE
}

// What the parts say about their ground does not change from frame to frame, and a preview asks every frame, so the
// answer is kept for as long as the same parts array (of the same length) is asked about.
const groundOfParts = new WeakMap()

function groundOf(parts, automaticAlbedo) {
  const key = JSON.stringify([parts.length, automaticAlbedo])
  const remembered = groundOfParts.get(parts)
  if (remembered?.key === key) {
    return remembered.ground
  }
  const found = isDrawnWithBakedLight(parts) ? null : findGroundSurface(parts) ?? (automaticAlbedo && { albedo: automaticAlbedo })
  const ground = found && !isClosedRoom(parts) ? found : null
  groundOfParts.set(parts, { key, ground })
  return ground
}

// A closed room lit by lamps. A wall a lamp lights becomes a dim lamp itself, and the walls light each other again. With a
// lamp of intensity I (flux 4 pi I), exposed wall area A and mean albedo rho, the light that reaches an average point after
// all the bounces is E = flux * rho / (A * (1 - rho)); a white surface sends back E / pi, the unit of an environment map's
// diffuse light. Each colour channel uses its own albedo, so a room of red walls bounces red light.
const ROOM_UNKNOWN_ALBEDO = 0.5
const ROOM_MAXIMUM_ALBEDO = 0.95
const FULL_SPHERE = 4 * Math.PI
// What the estimate keeps of the average bounce: furniture and open sides take some of it, and a flat fill has no gradient to
// make up for it. Fitted on `lit-interior`, `metal-room` and `brick-room` against Cycles (see docs/lighting.md).
const ROOM_BOUNCE_GAIN = 0.8
const KEY_LIGHT_THRESHOLD = 1e-3

function transformPoint(matrix, positions, vertexIndex, out) {
  for (let axis = 0; axis < 3; axis++) {
    out[axis] = matrix[axis] * positions[vertexIndex * 3] + matrix[4 + axis] * positions[vertexIndex * 3 + 1] + matrix[8 + axis] * positions[vertexIndex * 3 + 2] + matrix[12 + axis]
  }
  return out
}

// The area of a part's triangles whose front face looks at `viewpoint`: the walls of a room face its middle, and the outer
// side of a wall, which no light reaches, does not count.
function areaFacing(part, viewpoint) {
  const { positions, indices } = part.geometry
  const first = [0, 0, 0]
  const second = [0, 0, 0]
  const third = [0, 0, 0]
  let area = 0
  for (let corner = 0; corner < indices.length; corner += 3) {
    transformPoint(part.matrix, positions, indices[corner], first)
    transformPoint(part.matrix, positions, indices[corner + 1], second)
    transformPoint(part.matrix, positions, indices[corner + 2], third)
    const normalX = (second[1] - first[1]) * (third[2] - first[2]) - (second[2] - first[2]) * (third[1] - first[1])
    const normalY = (second[2] - first[2]) * (third[0] - first[0]) - (second[0] - first[0]) * (third[2] - first[2])
    const normalZ = (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0])
    const facing = normalX * (viewpoint[0] - first[0]) + normalY * (viewpoint[1] - first[1]) + normalZ * (viewpoint[2] - first[2])
    if (facing > 0) {
      area += 0.5 * Math.hypot(normalX, normalY, normalZ)
    }
  }
  return area
}

export function partDiffuseAlbedo(material) {
  const known = groundAlbedo(material)
  if (known) {
    return known
  }
  return (material.metallic ?? 0) > GROUND_MAXIMUM_METALLIC ? [0, 0, 0] : [ROOM_UNKNOWN_ALBEDO, ROOM_UNKNOWN_ALBEDO, ROOM_UNKNOWN_ALBEDO]
}

/**
 * The surfaces of a closed room as `{ minimum, maximum, area, albedo }`: the scene's bounds, the area of the faces that look
 * at its middle and their area-weighted mean linear albedo. Null when the scene is not a closed room, or is drawn with a
 * bake (its light map holds the bounce).
 */
export function findRoomSurface(parts) {
  if (parts.length === 0 || isDrawnWithBakedLight(parts) || !isClosedRoom(parts)) {
    return null
  }
  const { minimum, maximum } = sceneBoundsOf(parts.map(part => worldBounds(part)))
  const middle = minimum.map((low, axis) => (low + maximum[axis]) / 2)
  let area = 0
  const albedoSum = [0, 0, 0]
  for (const part of parts) {
    if (['blend', 'add'].includes(part.material?.alphaMode)) {
      continue
    }
    const partArea = areaFacing(part, middle)
    const albedo = partDiffuseAlbedo(part.material ?? {})
    area += partArea
    for (let channel = 0; channel < 3; channel++) {
      albedoSum[channel] += partArea * albedo[channel]
    }
  }
  return area > 0 ? { minimum, maximum, area, albedo: albedoSum.map(sum => sum / area) } : null
}

function isInside(position, { minimum, maximum }) {
  return position.every((value, axis) => value >= minimum[axis] && value <= maximum[axis])
}

// The flux of each local light inside the room, per colour channel, in intensity times steradians: a point light spreads over
// the whole sphere, a spot light over its cone, an area light over one side as a Lambert emitter (pi).
function lightFlux(environment, room) {
  const flux = [0, 0, 0]
  const add = (light, steradians) => {
    if (!isInside(light.position, room)) {
      return
    }
    const color = light.color ?? [1, 1, 1]
    for (let channel = 0; channel < 3; channel++) {
      flux[channel] += color[channel] * (light.intensity ?? 1) * steradians
    }
  }
  for (const light of environment.pointLights ?? []) add(light, FULL_SPHERE)
  for (const light of environment.spotLights ?? []) add(light, 2 * Math.PI * (1 - Math.cos(light.angle ?? Math.PI / 4)))
  for (const light of environment.areaLights ?? []) add(light, Math.PI)
  return flux
}

/**
 * The diffuse light the walls of `room` bounce back at an average point, linear RGB in the unit of an environment map's
 * diffuse light (what `environmentDiffuse` returns): the flux of the local lights in `environment`, the room's area and its
 * mean albedo give flux / pi * rho / (area * (1 - rho)) in each channel.
 */
export function roomBounceRadiance(room, environment) {
  return lightFlux(environment, room).map((flux, channel) => {
    const albedo = Math.min(room.albedo[channel], ROOM_MAXIMUM_ALBEDO)
    return ROOM_BOUNCE_GAIN * (flux / Math.PI) * albedo / (room.area * (1 - albedo))
  })
}

// A sun that reaches the room (a window, a skylight) is light the estimate does not count, and such a scene already reads as
// light as Cycles in its shadows (`temple-hall`, `dark-shaft`): only a room lit by its lamps alone gets the bounce.
function hasKeyLight(environment) {
  const keyColor = environment.keyColor
  if (!keyColor) {
    return true
  }
  return (environment.keyIntensity ?? 1) * (keyColor[0] + keyColor[1] + keyColor[2]) > KEY_LIGHT_THRESHOLD
}

const roomOfParts = new WeakMap()

function roomOf(parts) {
  const remembered = roomOfParts.get(parts)
  if (remembered?.length === parts.length) {
    return remembered.room
  }
  const room = findRoomSurface(parts)
  roomOfParts.set(parts, { length: parts.length, room })
  return room
}

// The renderer calls this method of a bounced map with the map's irradiance coefficients. The bounce is a constant diffuse
// light: it adds to the first coefficient, which the map's intensity scales again in the shader. The result is one shared
// scratch array, which the renderer uploads at once.
let bouncedIrradiance = null

function irradianceWithBounce(irradiance) {
  if (bouncedIrradiance?.length !== irradiance.length) {
    bouncedIrradiance = new Float32Array(irradiance.length)
  }
  bouncedIrradiance.set(irradiance)
  for (let channel = 0; channel < 3; channel++) {
    bouncedIrradiance[channel] += this.bounce[channel] / Math.max(this.intensity, 1e-6)
  }
  return bouncedIrradiance
}

// The map gets a `bounce` colour and the method that adds it to its diffuse light; without the method the renderer never draws
// the colour. The map's data stays shared, so a lamp whose power changes every frame costs no new prefilter.
function withBounce(map, bounce) {
  return { ...map, bounce, irradianceWithBounce }
}

function roomBounceEnvironment(parts, environment) {
  if (environment.roomBounce === false || hasKeyLight(environment)) {
    return environment
  }
  const room = roomOf(parts)
  if (!room) {
    return environment
  }
  const bounce = roomBounceRadiance(room, environment)
  return bounce.some(channel => channel > 0) ? { ...environment, map: withBounce(environment.map, bounce) } : environment
}


// The term knows the sun and the sky only. A scene lit by point, spot or area lights has a floor those lights brighten, which
// it would not count, so it would take the sky's own light away from the lower half and darken the scene (measured on
// `light-linking` and `spot-area`).
function hasLocalLights(environment) {
  return [environment.pointLights, environment.spotLights, environment.areaLights].some(lights => lights?.length > 0)
}

// Under a low sun a shadow is lit by more than the sky and the level ground: slopes, walls and roofs that face the sun send
// it back too, and the ground term above does not see them (`mountain-valley` has no level ground at all). The sky's own light
// is already in the map. The fill is a constant diffuse light, a `bounce` colour like the room's: the sun on a surface of the
// ground's albedo (at least 0.2) over pi, times a fitted gain, and times how much more a vertical face gets than the ground,
// squared: nothing for a high sun, whose ground bounce is the whole story (the studio scenes, `long-street`), most for a sun
// near the horizon (`mountain-valley`, `megacity-dusk`). A closed room, a bake or no sun gets none, so `temple-hall` and
// `dark-shaft` keep their shadows.
const OUTDOOR_FILL_GAIN = 0.4
const OUTDOOR_MINIMUM_ALBEDO = 0.2

const openAirOfParts = new WeakMap()

function isOpenAir(parts) {
  const remembered = openAirOfParts.get(parts)
  if (remembered?.length === parts.length) {
    return remembered.openAir
  }
  const openAir = !isDrawnWithBakedLight(parts) && !isClosedRoom(parts)
  openAirOfParts.set(parts, { length: parts.length, openAir })
  return openAir
}

// The fill as a `bounce` colour, or null when the scene gets none.
function outdoorFillBounce(parts, environment, ground) {
  if (environment.outdoorFill === false || !environment.keyColor || !hasKeyLight(environment) || !isOpenAir(parts)) {
    return null
  }
  const { lightDirection } = environment
  const sunLength = Math.hypot(...lightDirection)
  const sunOnGround = Math.max(lightDirection[1] / sunLength, 0)
  const sunOnWall = Math.hypot(lightDirection[0], lightDirection[2]) / sunLength
  const lowSun = Math.max(sunOnWall - sunOnGround, 0) ** 2
  if (lowSun === 0) {
    return null
  }
  const albedo = (ground?.albedo ?? [0, 0, 0]).map(channel => Math.max(channel, OUTDOOR_MINIMUM_ALBEDO))
  return albedo.map((channel, index) => (OUTDOOR_FILL_GAIN * channel * environment.keyColor[index] * (environment.keyIntensity ?? 1) * lowSun) / Math.PI)
}

/**
 * The environment with the ground's bounce in its map, found from the parts: the same environment when the scene has no
 * plain floor, a baked part (its light map already holds the bounce), a closed room (a bake or the room's own walls
 * give that light), a point, spot or area light, or no map. A closed room lit by point, spot or area lights gets its walls'
 * bounced light instead, as a `bounce` colour on the map (`environment.roomBounce: false` turns that off). `automaticAlbedo` is the colour of a floor the preview adds when no part forms one.
 * `environment.groundBounce: false` turns it off.
 */
export function groundBounceEnvironment(parts, environment, { automaticAlbedo = null } = {}) {
  if (!environment.map) {
    return environment
  }
  if (hasLocalLights(environment)) {
    return roomBounceEnvironment(parts, environment)
  }
  if (environment.groundBounce === false) {
    return environment
  }
  const ground = groundOf(parts, automaticAlbedo)
  const fill = outdoorFillBounce(parts, environment, ground)
  if (!ground) {
    return fill ? { ...environment, map: withBounce(environment.map, fill) } : environment
  }
  const { lightDirection } = environment
  const keyColor = environment.keyColor.map(channel => channel * (environment.keyIntensity ?? 1))
  const key = JSON.stringify([ground.albedo, keyColor, lightDirection, fill])
  const byInputs = cache.get(environment.map) ?? new Map()
  cache.set(environment.map, byInputs)
  if (!byInputs.has(key)) {
    const bounced = withGroundBounce(environment.map, { albedo: ground.albedo, keyColor, lightDirection })
    byInputs.set(key, fill ? withBounce(bounced, fill) : bounced)
  }
  return { ...environment, map: byInputs.get(key) }
}
