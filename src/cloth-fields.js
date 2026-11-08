import { bakeCloth } from './cloth.js';
import { addFieldAcceleration } from './force-fields.js';

// Adds every field's acceleration to the velocity of every particle for one substep.
function createFieldApplier(fields) {
  const position = [0, 0, 0];
  const velocity = [0, 0, 0];
  const acceleration = [0, 0, 0];
  return (positions, velocities, time, substepSeconds) => {
    for (let particle = 0; particle < positions.length / 3; particle++) {
      for (let axis = 0; axis < 3; axis++) {
        position[axis] = positions[particle * 3 + axis];
        velocity[axis] = velocities[particle * 3 + axis];
        acceleration[axis] = 0;
      }
      for (const field of fields) {
        addFieldAcceleration(field, position, velocity, time, acceleration);
      }
      for (let axis = 0; axis < 3; axis++) {
        velocities[particle * 3 + axis] += acceleration[axis] * substepSeconds;
      }
    }
  };
}

/** `bakeCloth` with the shared force field evaluation attached. Used inline and by the kernel worker alike. */
export function bakeClothWithFields(positions, triangles, options) {
  return bakeCloth(positions, triangles, options.fields?.length ? { ...options, applyFields: createFieldApplier(options.fields) } : options);
}
