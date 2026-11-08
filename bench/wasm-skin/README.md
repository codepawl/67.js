# Skin kernel: JavaScript against Rust and WebAssembly

Issue #572 asked whether moving hot code to Rust pays. This folder ports the per-frame skin kernel of `src/skinning.js`
(`updateSkinPose` and `validateSkinPose`) to Rust, compiles it to WebAssembly with no crates and no wasm-bindgen, and
times both on the same frames.

```sh
cd bench/wasm-skin
cargo build --release --target wasm32-unknown-unknown
cd ../..
node bench/wasm-skin/bench.mjs
```

The bench records joint matrices from 8 animated RobotExpressive characters (the runtime benchmark's
`skinned-characters` load: 32 skinned parts, 43 joints each, 8,864 skinned vertices, 1,856 distinct influence sets),
runs both kernels on those frames, and checks that the palettes match bit for bit. The WebAssembly time includes
copying each frame's matrices into its memory and the palette out.

## Result (2026-11-08, i7-14700KF, Node 24, machine shared with other jobs)

| Kernel | ms per frame, 8 characters |
| --- | --- |
| JavaScript, after #572 | 0.379 (0.361 to 0.442) |
| Rust to WebAssembly | 0.160 (0.153 to 0.179) |

The Rust kernel is 2.4 times faster and gives identical palettes (0 mismatched bits over 240 frames). The WebAssembly
file is 25 KB.

## Decision

Not shipped in the engine. After the #572 fix the whole `applyAnimation` for 8 characters is about 1 to 2 ms, and this
kernel is 0.38 ms of it, so the port saves about 0.2 ms per frame. Shipping it would add a 25 KB binary, an asynchronous
start-up step and a Rust toolchain to CI for that. The #572 fix itself (one `preparePose` per frame instead of two,
validating each distinct influence set once, no per-frame snapshot allocation) cut the same path from 4.5 ms to about
1.5 ms in plain JavaScript. Revisit if a profile shows a pure-math loop above a few milliseconds per frame.
