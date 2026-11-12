const fs = require('fs');
const dir = process.argv[2];
for (const scene of ['blend', 'sheen', 'specular-tint', 'anisotropy', 'iridescence', 'absorption', 'composite']) {
  for (const variant of ['before', 'cook']) {
    const path = `${dir}/${scene}-${variant}-compare.json`;
    if (!fs.existsSync(path)) { console.log(scene, variant, 'no compare json'); continue; }
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    const entry = Array.isArray(data) ? data[0] : (data.comparisons ? data.comparisons[0] : data);
    const keys = Object.keys(entry).join(',');
    console.log(scene, variant, JSON.stringify(entry).slice(0, 420));
    if (scene === 'blend' && variant === 'before') console.log('KEYS', keys);
  }
}
