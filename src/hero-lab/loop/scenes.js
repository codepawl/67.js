// The five worlds of the loop, in playing order. Each has a flight (keys at 0..1 along the route, played over `seconds`),
// a scrim strength for the headline on the left, and the credits the page must show while it plays.
// Eye and target are in the world's own units (metres). Flights were scouted against the real scenes, see FLIGHT NOTES in each entry.
const NVIDIA_SIMREADY = { label: 'NVIDIA SimReady assets', licence: 'CC BY 4.0', href: 'https://docs.omniverse.nvidia.com/usd/latest/usd_content_samples/simready_assets.html' };

export const SCENES = [
  {
    id: 'port',
    name: 'Container port',
    description: '/showcase/port/scene.json',
    poster: '/hero-lab/poster-b-port.webp',
    seconds: 10,
    scrim: 0.72,
    near: 2,
    far: 60000,
    keys: [
      { at: 0, eye: [-20, 130, -300], target: [0, -10, 10], fov: 38 },
      { at: 0.35, eye: [-150, 60, -150], target: [0, 20, 20], fov: 40 },
      { at: 0.68, eye: [30, 34, -170], target: [20, 26, 10], fov: 42 },
      { at: 1, eye: [205, 24, -62], target: [0, 22, 0], fov: 45 },
    ],
    credits: [
      { label: 'Gantry Crane by alanUscanga', licence: 'CC BY 4.0', href: 'https://sketchfab.com/3d-models/76119b46c26f436ba78f4b53c98fc935' },
      { label: 'KR Scania R_Draft by radzig541', licence: 'CC BY', href: 'https://sketchfab.com/3d-models/c46e8ee246aa4863a2cf602cddf1bfeb' },
    ],
  },
  {
    id: 'datacenter',
    name: 'Data center',
    description: '/showcase/datacenter/scene.json',
    seconds: 10,
    scrim: 0.7,
    near: 0.5,
    far: 400,
    keys: [
      { at: 0, eye: [17, 26, 38], target: [4, 0.4, 0.5], fov: 30 },
      { at: 1, eye: [-4, 9, 14], target: [4, 1.5, 0], fov: 34 },
    ],
    credits: [
      { label: 'Substation Transformer by HalfCarrot', licence: 'CC BY', href: 'https://sketchfab.com/3d-models/3a033547daaa4ec8b7b0426a3ecac987' },
      { label: 'Compact 07 by Daniel Zhabotinsky', licence: 'CC BY 4.0', href: 'https://sketchfab.com/3d-models/compact-07-low-poly-model-25c6874d173a4f6ca63e150bbd505686' },
    ],
  },
  {
    id: 'chipfab',
    name: 'Chip fab',
    description: '/showcase/chipfab/scene.json',
    seconds: 10,
    scrim: 0.6,
    near: 0.5,
    far: 4000,
    keys: [
      { at: 0, eye: [80.7, 76.4, 118.6], target: [77.6, 69.3, 109.4], fov: 30 },
      { at: 0.5, eye: [64, 75, 114], target: [60, 69, 107], fov: 32 },
      { at: 1, eye: [46, 76, 116], target: [42, 69, 108], fov: 34 },
    ],
    credits: [],
  },
  {
    id: 'warehouse',
    name: 'Warehouse',
    description: '/showcase/warehouse/scene.json',
    seconds: 10,
    scrim: 0.62,
    near: 0.3,
    far: 400,
    keys: [
      { at: 0, eye: [30, 22, 40], target: [4, 1, -1], fov: 32 },
      { at: 0.3, eye: [14, 16, 27], target: [0, 1.5, -4], fov: 38 },
      { at: 0.62, eye: [0, 9.5, 15], target: [-8, 1.5, -8], fov: 46 },
      { at: 1, eye: [-16, 4.5, 9], target: [-26, 2, -14], fov: 56 },
    ],
    credits: [NVIDIA_SIMREADY],
  },
  {
    id: 'darkstore',
    name: 'Dark store',
    description: '/showcase/darkstore/scene.json',
    seconds: 10,
    scrim: 0.62,
    near: 0.25,
    far: 300,
    keys: [
      { at: 0, eye: [22, 17, 22], target: [4, 0, -6], fov: 34 },
      { at: 0.5, eye: [6, 14.5, 18], target: [-2, 0, -10], fov: 38 },
      { at: 1, eye: [-10, 11, 9], target: [8, 0.5, -18], fov: 42 },
    ],
    credits: [NVIDIA_SIMREADY],
  },
];
