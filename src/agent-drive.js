import { createCameraPath } from './camera-path.js';
import { invalidField, withFieldPrefix } from './field-error.js';
import { createVehicleRig, driveAlongLegs, createVehicleNodeOverrides } from './vehicle.js';

// The `drive` entry of an asset recipe's motion and of a placed asset: a car driven along a path by the vehicle kit.
// Loaded on demand (module 'drive'); sampling is a pure function of time, so frames render in any order.

export { normalizeDrive } from './agent-drive-schema.js';

function resolvePath(path) {
  return Array.isArray(path) ? path : createCameraPath({ loop: false, ...path });
}

function rounded(value) {
  return Number(value.toFixed(5));
}

/**
 * Builds the rig and the drive for a decoded asset. `materialIds` are the ids a tail light may drive.
 * `sample(time)` returns the pose, the node overrides that put the asset in it, and the tail-light emission per material.
 */
export function createAssetDrive(asset, drive, { materialIds = null, fieldPath = 'motion.drive' } = {}) {
  return withFieldPrefix(fieldPath, () => buildAssetDrive(asset, drive, materialIds));
}

function buildAssetDrive(asset, drive, materialIds) {
  const { path, legs, wheels, body, forwardAxis, wheelbase, lights = {}, ...driveOptions } = drive;
  const rig = createVehicleRig({
    asset, wheels, body, forwardAxis, wheelbase,
    maxSteerAngle: driveOptions.maxSteerAngle,
    lights: { headlights: lights.headlights },
  });
  for (const [index, tail] of (lights.tailLights ?? []).entries()) {
    if (materialIds && !materialIds.has(tail.material)) {
      throw invalidField(`lights.tailLights[${index}].material`, tail.material, `the id of a material in the asset, one of ${[...materialIds].slice(0, 5).join(', ')}`);
    }
  }
  const vehicle = driveAlongLegs(rig, (legs ?? [{ path }]).map(leg => ({ ...leg, path: resolvePath(leg.path) })), driveOptions);
  const tailLights = lights.tailLights ?? [];
  return Object.freeze({
    rig,
    duration: vehicle.duration,
    length: vehicle.length,
    sample(time) {
      const pose = vehicle.sample(time);
      return {
        pose,
        nodeOverrides: createVehicleNodeOverrides(rig, pose),
        emissions: tailLights.map(tail => ({ material: tail.material, emission: (tail.off ?? 0) + ((tail.on ?? 4) - (tail.off ?? 0)) * pose.lights[tail.signal] })),
      };
    },
    /** What scene_inspect reports: the wheels found, the names turned down, and the light signals of a pose. */
    describe(pose) {
      return {
        wheels: rig.wheels.map(wheel => ({
          id: wheel.id, side: wheel.side, axle: wheel.axle, radius: rounded(wheel.radius), steerable: wheel.steerable,
          nodes: wheel.entries.map(entry => entry.label),
        })),
        rejectedNames: rig.rejectedNames,
        wheelbase: rounded(rig.wheelbase),
        trackWidth: rounded(rig.trackWidth),
        duration: rounded(vehicle.duration),
        length: rounded(vehicle.length),
        ...(pose ? {
          lights: {
            brake: rounded(pose.lights.brake),
            reverse: pose.lights.reverse,
            headlights: pose.lights.headlights.map(light => ({ id: light.id, position: light.position.map(rounded), direction: light.direction.map(rounded) })),
          },
          speed: rounded(pose.speed),
          direction: pose.direction,
        } : {}),
      };
    },
  });
}
