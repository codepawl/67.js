// The Jolt engine adapter for the live physics runtime (physics-runtime.js). Jolt is JoltPhysics built to wasm by the
// `jolt-physics` package, an optional peer dependency: nothing in the core imports it. The adapter has the same shape as
// `rapierAdapter` and passes the same runtime tests, so a game picks an engine with `createPhysicsSystem(definition,
// { adapter: joltAdapter })`. See docs/physics-runtime.md for what it supports.
import { evaluateForceFields } from './force-fields.js';

export const JOLT_ADAPTER_LIMITS = Object.freeze({
  maximumCollisionLayers: 256,
  maximumOverlaps: 1024,
});

const MAX_CONVEX_RADIUS = 0.05;
const SUPPORTED_SHAPES = ['ball', 'cuboid', 'capsule', 'cylinder', 'convexHull'];
const INSTALL_HINT = 'Install it with `npm install jolt-physics`, or build the system with rapierAdapter.';

let joltPromise;
let joltModule;

/**
 * Load the Jolt wasm module once. A page that ships its own copy passes `moduleUrl`, the absolute URL of
 * jolt-physics.wasm.js; that file fetches the .wasm file next to it, so nothing loads from another origin.
 */
export function loadJoltEngine({ moduleUrl } = {}) {
  joltPromise ??= (moduleUrl === undefined ? import('jolt-physics') : import(/* @vite-ignore */ moduleUrl)).then(async module => {
    joltModule = await (module.default ?? module)();
    return joltModule;
  }, error => {
    joltPromise = undefined;
    throw new Error(`The jolt adapter needs the "jolt-physics" package, which failed to load: ${error.message}. ${INSTALL_HINT}`);
  });
  return joltPromise;
}

function requireJolt() {
  if (!joltModule) throw new Error('The jolt engine is not loaded. Await loadJoltEngine(), or create the system with createPhysicsSystem, which does it.');
  return joltModule;
}

// Rapier and Jolt both collide two colliders when each one's group is in the other's mask. Jolt keys that on an
// object layer, so every distinct (groups, mask, sensor) triple becomes one layer.
function collectCollisionLayers(prepared) {
  const layers = [];
  const layerOfCollider = prepared.colliders.map(collider => {
    const sensor = collider.sensor === true;
    let index = layers.findIndex(layer => layer.groups === collider.groups && layer.mask === collider.mask && layer.sensor === sensor);
    if (index < 0) {
      index = layers.length;
      layers.push({ groups: collider.groups, mask: collider.mask, sensor });
    }
    return index;
  });
  if (layers.length > JOLT_ADAPTER_LIMITS.maximumCollisionLayers) {
    throw new RangeError(`The jolt adapter supports at most ${JOLT_ADAPTER_LIMITS.maximumCollisionLayers} distinct collision group and mask combinations, got ${layers.length}. Reuse the same groups and mask values across colliders.`);
  }
  return { layers, layerOfCollider };
}

function validateSupported(prepared) {
  if (prepared.joints.length) {
    throw new TypeError('The jolt adapter does not build joints yet. Remove the joints or create the system with rapierAdapter.');
  }
  const colliderCount = new Array(prepared.bodies.length).fill(0);
  for (const collider of prepared.colliders) {
    if (!SUPPORTED_SHAPES.includes(collider.shape)) {
      throw new TypeError(`The jolt adapter supports ${SUPPORTED_SHAPES.join(', ')} colliders; collider "${collider.name}" is ${collider.shape}. Use one of those shapes or rapierAdapter.`);
    }
    colliderCount[collider.body] += 1;
  }
  colliderCount.forEach((count, bodyIndex) => {
    const body = prepared.bodies[bodyIndex];
    if (count > 1) {
      throw new TypeError(`The jolt adapter takes one collider per body; body "${body.name}" has ${count}. Split it into one body per collider, or use rapierAdapter.`);
    }
    if (count === 0 && body.type === 'dynamic') {
      throw new TypeError(`A dynamic body needs a collider for the jolt adapter; body "${body.name}" has none.`);
    }
  });
}

function createJoltWorld(prepared) {
  const Jolt = requireJolt();
  validateSupported(prepared);
  const { layers, layerOfCollider } = collectCollisionLayers(prepared);
  const owned = [];
  const own = object => {
    owned.push(object);
    return object;
  };

  const layerCount = Math.max(1, layers.length);
  const pairFilter = new Jolt.ObjectLayerPairFilterTable(layerCount);
  layers.forEach((first, firstIndex) => {
    layers.forEach((second, secondIndex) => {
      if ((first.groups & second.mask) !== 0 && (second.groups & first.mask) !== 0) pairFilter.EnableCollision(firstIndex, secondIndex);
    });
  });
  const broadPhaseLayers = new Jolt.BroadPhaseLayerInterfaceTable(layerCount, 1);
  const broadPhaseLayer = own(new Jolt.BroadPhaseLayer(0));
  for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) broadPhaseLayers.MapObjectToBroadPhaseLayer(layerIndex, broadPhaseLayer);
  // The Jolt interface takes over the three layer objects above; destroying them again crashes the module.
  const settings = own(new Jolt.JoltSettings());
  settings.mObjectLayerPairFilter = pairFilter;
  settings.mBroadPhaseLayerInterface = broadPhaseLayers;
  settings.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(broadPhaseLayers, 1, pairFilter, layerCount);
  settings.mMaxBodies = Math.max(1024, prepared.bodies.length);

  const jolt = new Jolt.JoltInterface(settings);
  const physicsSystem = jolt.GetPhysicsSystem();
  const bodyInterface = physicsSystem.GetBodyInterface();
  const physicsSettings = physicsSystem.GetPhysicsSettings();
  physicsSettings.mNumVelocitySteps = prepared.solverIterations;
  physicsSystem.SetPhysicsSettings(physicsSettings);
  const scratchVector = own(new Jolt.Vec3());
  const scratchPosition = own(new Jolt.RVec3());
  const scratchRotation = own(new Jolt.Quat());
  scratchVector.Set(...prepared.gravity);
  physicsSystem.SetGravity(scratchVector);

  const bodies = [];
  const bodyIds = [];
  const colliderOfBodyIndex = new Map();
  const bodyOfIdIndex = new Map();
  const colliderOfBody = new Array(prepared.bodies.length).fill(-1);
  prepared.colliders.forEach((collider, colliderIndex) => {
    colliderOfBody[collider.body] = colliderIndex;
  });

  const motionTypes = { dynamic: Jolt.EMotionType_Dynamic, fixed: Jolt.EMotionType_Static, kinematic: Jolt.EMotionType_Kinematic };

  function createShapeSettings(collider) {
    let shapeSettings;
    if (collider.shape === 'ball') {
      shapeSettings = new Jolt.SphereShapeSettings(collider.radius);
    } else if (collider.shape === 'cuboid') {
      const halfExtents = own(new Jolt.Vec3(...collider.halfExtents));
      shapeSettings = new Jolt.BoxShapeSettings(halfExtents, Math.min(MAX_CONVEX_RADIUS, ...collider.halfExtents) * 0.5);
    } else if (collider.shape === 'capsule') {
      shapeSettings = new Jolt.CapsuleShapeSettings(collider.halfHeight, collider.radius);
    } else if (collider.shape === 'cylinder') {
      shapeSettings = new Jolt.CylinderShapeSettings(collider.halfHeight, collider.radius, Math.min(MAX_CONVEX_RADIUS, collider.halfHeight, collider.radius) * 0.5);
    } else {
      shapeSettings = new Jolt.ConvexHullShapeSettings();
      for (let index = 0; index < collider.points.length; index += 3) {
        shapeSettings.mPoints.push_back(own(new Jolt.Vec3(collider.points[index], collider.points[index + 1], collider.points[index + 2])));
      }
    }
    if (collider.density !== undefined) shapeSettings.mDensity = collider.density;
    const hasOffset = collider.translation.some(component => component !== 0) || collider.rotation.some((component, axis) => component !== [0, 0, 0, 1][axis]);
    if (!hasOffset) return shapeSettings;
    const offset = new Jolt.Vec3(...collider.translation);
    const rotation = new Jolt.Quat(...collider.rotation);
    own(offset);
    own(rotation);
    return new Jolt.RotatedTranslatedShapeSettings(offset, rotation, shapeSettings);
  }

  function createShape(collider) {
    const shapeResult = createShapeSettings(collider).Create();
    if (shapeResult.HasError()) {
      throw new RangeError(`Collider "${collider.name}" could not be built by jolt: ${shapeResult.GetError().c_str()}. Convex hull points must span a volume.`);
    }
    return shapeResult.Get();
  }

  function freeWorld() {
    for (const bodyId of bodyIds) {
      bodyInterface.RemoveBody(bodyId);
      bodyInterface.DestroyBody(bodyId);
    }
    Jolt.destroy(jolt);
    for (const object of owned.reverse()) Jolt.destroy(object);
  }

  function addBody(body, bodyIndex) {
    const colliderIndex = colliderOfBody[bodyIndex];
    const collider = colliderIndex >= 0 ? prepared.colliders[colliderIndex] : undefined;
    let shape;
    if (collider) {
      shape = createShape(collider);
    } else {
      shape = new Jolt.EmptyShapeSettings().Create().Get();
    }
    const position = new Jolt.RVec3(...body.translation);
    const rotation = new Jolt.Quat(...body.rotation);
    const creation = new Jolt.BodyCreationSettings(shape, position, rotation, motionTypes[body.type], collider ? layerOfCollider[colliderIndex] : 0);
    own(position);
    own(rotation);
    own(creation);
    if (collider) {
      creation.mIsSensor = collider.sensor === true;
      creation.mFriction = collider.friction;
      creation.mRestitution = collider.restitution;
      if (collider.mass !== undefined && body.type === 'dynamic') {
        creation.mOverrideMassProperties = Jolt.EOverrideMassProperties_CalculateInertia;
        creation.mMassPropertiesOverride.mMass = collider.mass;
      }
    }
    if (body.type === 'dynamic') {
      scratchVector.Set(...body.linearVelocity);
      creation.mLinearVelocity = scratchVector;
      scratchVector.Set(...body.angularVelocity);
      creation.mAngularVelocity = scratchVector;
      creation.mLinearDamping = body.linearDamping;
      creation.mAngularDamping = body.angularDamping;
      if (body.ccd) creation.mMotionQuality = Jolt.EMotionQuality_LinearCast;
    }
    const created = bodyInterface.CreateBody(creation);
    bodyInterface.AddBody(created.GetID(), Jolt.EActivation_Activate);
    bodies.push(created);
    bodyIds.push(created.GetID());
    bodyOfIdIndex.set(created.GetID().GetIndex(), created);
    if (collider) colliderOfBodyIndex.set(created.GetID().GetIndex(), colliderIndex);
  }

  // A throw while building must not leave the Jolt interface, bodies or owned objects alive: no caller holds the world yet.
  try {
    prepared.bodies.forEach(addBody);
  } catch (error) {
    freeWorld();
    throw error;
  }

  // Jolt reports a contact as removed when a body falls asleep; Rapier does not. Track which pairs are touching so a
  // sleeping body neither ends nor restarts its contact, and every adapter reports the same started and stopped pairs.
  const touchingPairs = new Set();
  const pendingEvents = [];
  const pairKey = (first, second) => (first < second ? `${first}:${second}` : `${second}:${first}`);
  const listener = own(new Jolt.ContactListenerJS());
  listener.OnContactValidate = () => Jolt.ValidateResult_AcceptAllContactsForThisBodyPair;
  listener.OnContactAdded = (firstPointer, secondPointer) => {
    const first = colliderOfBodyIndex.get(Jolt.wrapPointer(firstPointer, Jolt.Body).GetID().GetIndex());
    const second = colliderOfBodyIndex.get(Jolt.wrapPointer(secondPointer, Jolt.Body).GetID().GetIndex());
    const key = pairKey(first, second);
    if (touchingPairs.has(key)) return;
    touchingPairs.add(key);
    pendingEvents.push([first, second, true]);
  };
  listener.OnContactPersisted = () => {};
  listener.OnContactRemoved = pairPointer => {
    const pair = Jolt.wrapPointer(pairPointer, Jolt.SubShapeIDPair);
    const firstBody = bodyOfIdIndex.get(pair.GetBody1ID().GetIndex());
    const secondBody = bodyOfIdIndex.get(pair.GetBody2ID().GetIndex());
    const first = colliderOfBodyIndex.get(pair.GetBody1ID().GetIndex());
    const second = colliderOfBodyIndex.get(pair.GetBody2ID().GetIndex());
    const key = pairKey(first, second);
    const bodyFellAsleep = [firstBody, secondBody].some(body => body && !body.IsStatic() && !body.IsActive());
    if (bodyFellAsleep || !touchingPairs.has(key)) return;
    touchingPairs.delete(key);
    pendingEvents.push([first, second, false]);
  };
  physicsSystem.SetContactListener(listener);

  const kinematicTargets = new Map();
  const narrowPhaseQuery = physicsSystem.GetNarrowPhaseQuery();
  const broadPhaseFilter = own(new Jolt.BroadPhaseLayerFilter());
  const shapeFilter = own(new Jolt.ShapeFilter());
  const plainBodyFilter = own(new Jolt.BodyFilter());
  const activeQuery = { mask: 0xffff, includeSensors: false };
  const layerFilter = own(new Jolt.ObjectLayerFilterJS());
  layerFilter.ShouldCollide = layerIndex => {
    const layer = layers[layerIndex];
    return (layer.sensor ? activeQuery.includeSensors : true) && (layer.groups & activeQuery.mask) !== 0 && layer.mask !== 0;
  };
  const rayCollector = own(new Jolt.CastRayClosestHitCollisionCollector());
  const rayCastSettings = own(new Jolt.RayCastSettings());
  const shapeCollector = own(new Jolt.CastShapeClosestHitCollisionCollector());
  const shapeCastSettings = own(new Jolt.ShapeCastSettings());
  const overlapCollector = own(new Jolt.CollideShapeAllHitCollisionCollector());
  const overlapSettings = own(new Jolt.CollideShapeSettings());
  const unitScale = own(new Jolt.Vec3(1, 1, 1));
  const zeroOffset = own(new Jolt.RVec3(0, 0, 0));

  // A query shape is a short-lived reference counted Jolt shape.
  function withQueryShape(shape, action) {
    let joltShape;
    if (shape.type === 'ball') {
      joltShape = new Jolt.SphereShape(shape.radius);
    } else if (shape.type === 'capsule') {
      joltShape = new Jolt.CapsuleShape(shape.halfHeight, shape.radius);
    } else {
      const halfExtents = new Jolt.Vec3(...shape.halfExtents);
      joltShape = new Jolt.BoxShape(halfExtents, Math.min(MAX_CONVEX_RADIUS, ...shape.halfExtents) * 0.5);
      Jolt.destroy(halfExtents);
    }
    joltShape.AddRef();
    try {
      return action(joltShape);
    } finally {
      joltShape.Release();
    }
  }

  function withTransform(translation, rotation, action) {
    scratchPosition.Set(...translation);
    scratchRotation.Set(...rotation);
    const transform = Jolt.RMat44.prototype.sRotationTranslation(scratchRotation, scratchPosition);
    try {
      return action(transform);
    } finally {
      Jolt.destroy(transform);
    }
  }

  function withQueryFilters(filter, action) {
    activeQuery.mask = filter.mask;
    activeQuery.includeSensors = filter.includeSensors;
    const excluded = filter.excludeBody === undefined ? undefined : new Jolt.IgnoreSingleBodyFilter(bodyIds[filter.excludeBody]);
    try {
      return action(excluded ?? plainBodyFilter);
    } finally {
      if (excluded) Jolt.destroy(excluded);
    }
  }

  function reversedUnit(axis) {
    const length = Math.hypot(axis.GetX(), axis.GetY(), axis.GetZ());
    return [-axis.GetX() / length, -axis.GetY() / length, -axis.GetZ() / length];
  }

  return {
    step(stepSeconds, elapsedSeconds) {
      for (const [bodyIndex, target] of kinematicTargets) {
        const body = bodies[bodyIndex];
        const currentPosition = body.GetPosition();
        const currentRotation = body.GetRotation();
        scratchPosition.Set(...(target.translation ?? [currentPosition.GetX(), currentPosition.GetY(), currentPosition.GetZ()]));
        scratchRotation.Set(...(target.rotation ?? [currentRotation.GetX(), currentRotation.GetY(), currentRotation.GetZ(), currentRotation.GetW()]));
        bodyInterface.MoveKinematic(bodyIds[bodyIndex], scratchPosition, scratchRotation, stepSeconds);
      }
      const movedKinematicBodies = [...kinematicTargets.keys()];
      kinematicTargets.clear();
      if (prepared.fields.length) {
        const acceleration = [0, 0, 0];
        prepared.bodies.forEach((description, bodyIndex) => {
          if (description.type !== 'dynamic') return;
          const body = bodies[bodyIndex];
          const position = body.GetPosition();
          const velocity = body.GetLinearVelocity();
          evaluateForceFields(prepared.fields, [position.GetX(), position.GetY(), position.GetZ()], [velocity.GetX(), velocity.GetY(), velocity.GetZ()], elapsedSeconds, acceleration);
          if (!(acceleration[0] || acceleration[1] || acceleration[2])) return;
          const scale = stepSeconds / body.GetMotionProperties().GetInverseMass();
          scratchVector.Set(acceleration[0] * scale, acceleration[1] * scale, acceleration[2] * scale);
          bodyInterface.AddImpulse(bodyIds[bodyIndex], scratchVector);
        });
      }
      jolt.Step(stepSeconds, 1);
      // MoveKinematic leaves the velocity that reached the target; Rapier parks the body there, so stop it.
      scratchVector.Set(0, 0, 0);
      for (const bodyIndex of movedKinematicBodies) bodyInterface.SetLinearAndAngularVelocity(bodyIds[bodyIndex], scratchVector, scratchVector);
    },
    readPose(bodyIndex, output) {
      const position = bodies[bodyIndex].GetPosition();
      const rotation = bodies[bodyIndex].GetRotation();
      output[0] = position.GetX();
      output[1] = position.GetY();
      output[2] = position.GetZ();
      output[3] = rotation.GetX();
      output[4] = rotation.GetY();
      output[5] = rotation.GetZ();
      output[6] = rotation.GetW();
    },
    setKinematicPose(bodyIndex, translation, rotation) {
      const target = kinematicTargets.get(bodyIndex) ?? {};
      if (translation) target.translation = translation;
      if (rotation) target.rotation = rotation;
      kinematicTargets.set(bodyIndex, target);
    },
    setLinearVelocity(bodyIndex, velocity) {
      scratchVector.Set(...velocity);
      bodyInterface.SetLinearVelocity(bodyIds[bodyIndex], scratchVector);
      bodyInterface.ActivateBody(bodyIds[bodyIndex]);
    },
    applyImpulse(bodyIndex, impulse, point) {
      scratchVector.Set(...impulse);
      if (point) {
        scratchPosition.Set(...point);
        bodyInterface.AddImpulse(bodyIds[bodyIndex], scratchVector, scratchPosition);
      } else {
        bodyInterface.AddImpulse(bodyIds[bodyIndex], scratchVector);
      }
    },
    drainEvents(callback) {
      const events = pendingEvents.splice(0);
      for (const [first, second, started] of events) callback(first, second, started);
    },
    raycast(origin, direction, maxDistance, filter) {
      rayCollector.Reset();
      scratchPosition.Set(...origin);
      scratchVector.Set(direction[0] * maxDistance, direction[1] * maxDistance, direction[2] * maxDistance);
      const ray = new Jolt.RRayCast(scratchPosition, scratchVector);
      withQueryFilters(filter, bodyFilter => {
        narrowPhaseQuery.CastRay(ray, rayCastSettings, rayCollector, broadPhaseFilter, layerFilter, bodyFilter, shapeFilter);
      });
      Jolt.destroy(ray);
      if (!rayCollector.HadHit()) return null;
      const hit = rayCollector.mHit;
      const bodyIndex = hit.mBodyID.GetIndex();
      const distance = hit.mFraction * maxDistance;
      scratchPosition.Set(origin[0] + direction[0] * distance, origin[1] + direction[1] * distance, origin[2] + direction[2] * distance);
      const normal = bodyOfIdIndex.get(bodyIndex).GetWorldSpaceSurfaceNormal(hit.mSubShapeID2, scratchPosition);
      const result = { collider: colliderOfBodyIndex.get(bodyIndex), distance, normal: [normal.GetX(), normal.GetY(), normal.GetZ()] };
      Jolt.destroy(normal);
      return result;
    },
    shapeCast(shape, translation, rotation, direction, maxDistance, filter) {
      shapeCollector.Reset();
      withQueryShape(shape, joltShape => withTransform(translation, rotation, transform => {
        scratchVector.Set(direction[0] * maxDistance, direction[1] * maxDistance, direction[2] * maxDistance);
        const cast = new Jolt.RShapeCast(joltShape, unitScale, transform, scratchVector);
        withQueryFilters(filter, bodyFilter => {
          narrowPhaseQuery.CastShape(cast, shapeCastSettings, zeroOffset, shapeCollector, broadPhaseFilter, layerFilter, bodyFilter, shapeFilter);
        });
        Jolt.destroy(cast);
      }));
      if (!shapeCollector.HadHit()) return null;
      const hit = shapeCollector.mHit;
      return { collider: colliderOfBodyIndex.get(hit.mBodyID2.GetIndex()), distance: hit.mFraction * maxDistance, normal: reversedUnit(hit.mPenetrationAxis) };
    },
    overlap(shape, translation, rotation, filter) {
      overlapCollector.Reset();
      withQueryShape(shape, joltShape => withTransform(translation, rotation, transform => {
        withQueryFilters(filter, bodyFilter => {
          narrowPhaseQuery.CollideShape(joltShape, unitScale, transform, overlapSettings, zeroOffset, overlapCollector, broadPhaseFilter, layerFilter, bodyFilter, shapeFilter);
        });
      }));
      const hits = overlapCollector.mHits;
      const found = [];
      for (let hitIndex = 0; hitIndex < hits.size() && found.length < JOLT_ADAPTER_LIMITS.maximumOverlaps; hitIndex++) {
        found.push(colliderOfBodyIndex.get(hits.at(hitIndex).mBodyID2.GetIndex()));
      }
      return found;
    },
    free: freeWorld,
  };
}

/** The Jolt adapter for createPhysicsSystem: bodies, one collider each, sensors, groups, kinematic control, force fields and queries. */
export const joltAdapter = Object.freeze({
  name: 'jolt',
  load: loadJoltEngine,
  createWorld: createJoltWorld,
});
