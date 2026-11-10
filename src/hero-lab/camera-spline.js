// A smooth camera path through keyframes: Catmull-Rom through eye, target and field of view,
// so a scroll pass has no corners at the keys. Keys are { at, eye, target, fov } with `at` rising from 0 to 1.

function catmullRom(before, from, to, after, amount) {
  const squared = amount * amount;
  const cubed = squared * amount;
  return 0.5 * (2 * from + (to - before) * amount + (2 * before - 5 * from + 4 * to - after) * squared + (3 * from - before - 3 * to + after) * cubed);
}

function blendVectors(before, from, to, after, amount) {
  return from.map((value, axis) => catmullRom(before[axis], value, to[axis], after[axis], amount));
}

export function createCameraSpline(keys) {
  return function sample(progress) {
    const bounded = Math.max(0, Math.min(1, progress));
    let index = 0;
    while (index < keys.length - 2 && bounded > keys[index + 1].at) index++;
    const from = keys[index];
    const to = keys[index + 1];
    const before = keys[Math.max(0, index - 1)];
    const after = keys[Math.min(keys.length - 1, index + 2)];
    const amount = Math.max(0, Math.min(1, (bounded - from.at) / (to.at - from.at)));
    return {
      eye: blendVectors(before.eye, from.eye, to.eye, after.eye, amount),
      target: blendVectors(before.target, from.target, to.target, after.target, amount),
      fov: catmullRom(before.fov, from.fov, to.fov, after.fov, amount),
    };
  };
}
