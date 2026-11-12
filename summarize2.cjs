const fs = require('fs');
const dir = process.argv[2];
for (const scene of ['blend', 'sheen', 'specular-tint', 'anisotropy', 'iridescence', 'absorption', 'composite']) {
  for (const variant of ['before', 'cook']) {
    const entry = JSON.parse(fs.readFileSync(`${dir}/${scene}-${variant}-compare.json`, 'utf8'));
    const e = Array.isArray(entry) ? entry[0] : entry;
    const t = e.tileGrid8x8 ?? {};
    const tiles = t.tileRatios ?? t.ratios;
    console.log(scene.padEnd(14), variant.padEnd(7), 'mean', JSON.stringify(e.channelMeanRatio), 'relMSE', e.relMse.toPrecision(3), 'tiles', JSON.stringify({ ...t, entries: undefined, tiles: undefined, worstTiles: undefined, ratios: undefined }).slice(0, 200), 'gates', JSON.stringify(e.parityGates).slice(0, 200));
  }
}
