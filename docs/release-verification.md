# Release verification

## Fresh build gate

`npm pack` and `npm publish` run `prepack`, which rebuilds `build/` from `src/` (`npm run build:lib`) and then runs `node scripts/check-build-fresh.mjs`. The MCP build records `sourceDigest`, a hash of every file under `src/`, in `build/mcp/manifest.json`; the check fails the pack when that digest or `packageVersion` no longer matches the tree. A pack that skipped the rebuild (scripts turned off, a copied `build/`) therefore stops instead of shipping a game runtime or `build/mcp/server.mjs` that disagrees with `src/`. Run it by hand with `node scripts/check-build-fresh.mjs`.

Why it exists (#975): the 0.19.0 tarball was reported to carry a game runtime without `player.animation`, `maximumSpeed` and `npcs`. Its manifest says it was built from commit `3261feaa` with a clean tree, and that commit's `src/game-setup.js` has none of those fields (the animation and NPC work landed after it), so that build matched its own source. The tarball carries no `src/`, which the report assumed it did. The gate closes the real gap that remains: nothing proved a build matched the checkout it was packed from.


## 0.15.0: preview shares the package chunks (measured 2026-10-31)

The MCP preview page no longer bundles its own engine copy; it imports the chunks of the package build.
Source checks used Windows Node.js, installed Chrome and CPU SwiftShader. Registry publication was not checked.

| Check | Measured result |
| --- | --- |
| Archive | 802,581 bytes before, 695,041 after (one-line notices in built files, no Ajv in the MCP server), so 353,535 bytes are free under 1 MiB. Install size is unchanged. |
| Every export | `npm run smoke:package` loads each `exports` entry in a clean consumer. |
| Node tests | 1359 tests passed on 2026-10-31. The count grows with each pull request, so run `npm test` for the current number. |
| Clean source archive | `npm run smoke:package` passed. |
| Installed MCP CLI | `npm run smoke:mcp-package` (not protocol only) passed with a modern and a legacy client, and checked every `previewChunks` hash. |
| Real character | `npm run smoke:character` passed on the GPU. |
| First scene | Median of runtime launch, page load and first scene on SwiftShader: 981 ms before (7 runs), 974 ms after (11 runs). |

## 0.10.0 to 0.15.0

This file has no per-release tables for these versions. The `Test` workflow ran `npm test`, `npm run prepare:release`, `npm run smoke:package` and `npm run smoke:mcp-package` on each pull request. [CHANGELOG.md](../CHANGELOG.md) lists what each release changed and measured.

## 0.9.1

This patch updates the packaged roadmap and standalone MCP command. Runtime behavior matches the verified `0.9.0` source below.
Registry checks must verify the new archive and its exact source commit separately.

## 0.9.0

Source checks used Windows Node.js, installed Chrome with CPU SwiftShader and actual MCP calls.
Registry publication and live deployment require separate verification against the pushed commit.

| Check | Measured result |
| --- | --- |
| Node tests | 434 tests passed. |
| Native review | Front, side and back camera shots produced one labeled PNG grid. |
| Independent poses | An omitted second motion sample matched the authored base pixels exactly. |
| Imported clips | Explicit and omitted clip samples matched their independently rendered reference pixels. |
| Source preservation | Preview PNG bytes, canonical recipe, revision and checkpoint restoration survived reviews and invalid shots. |
| Active closure | Closing a confirmed active review released the runtime in 0.12 seconds. |

The review response limits shots to four, dimensions to 480 pixels per axis and PNG bytes to 1 MiB.
It keeps one pending frame and reports requested tile sizes separately from actual render dimensions.
The private review has a 30-second deadline after source snapshot and asset verification. Cleanup and preview recovery follow it.

The public contract review found a stalled page acquisition that could delay closure.
A rejecting cancellation race and late-page disposal removed that path. Regression tests failed before the correction and passed afterward.
The source follow-up found no remaining findings within its scope.


A clean source package passed modern and legacy MCP calls without development dependencies or source files.
These checks cover CPU rendering. They do not establish hardware GPU performance or better artistic quality.


## 0.8.1

Source checks used Windows Node.js, installed Chrome with CPU SwiftShader and FFmpeg H.264 encoding.
Registry publication and live deployment require separate verification against the pushed commit.

| Check | Measured result |
| --- | --- |
| Node tests | 417 tests passed. |
| Face coverage | More than 800 rays checked the complete eye aperture across combined expressions. |
| Smooth normals | Open, partial and closed expressions retained a minimum normal agreement above 0.985 against the continuous surface. |
| Native blink | Suppressing only the blink channel changed pixels. Backward seeking reproduced exact PNG bytes without WebGL errors. |
| Retained geometry | Four expression channels and scene cues preserved shared geometry and actor matrices. |
| Native video | Seventy-two decoded frames formed a three-second portrait H.264 MP4 at 24 FPS with BT.709 metadata. |
| CPU export | The 540 by 960 export took 24.23 seconds with one pending frame and 48.4 MB of estimated render memory. |

The scientist uses inset eyes, a sculpted face and held poses for each set.
Native open and closed closeups were inspected after the final normal correction.

This character remains stylized. These checks do not establish realistic likeness, cinematic quality or hardware GPU performance.
Additive normals remain an approximation of the combined surface. The tested expressions cover this actor, rather than arbitrary morph targets.

## 0.8.0

Source checks used Windows Node.js, installed Chrome with CPU SwiftShader and FFmpeg H.264 encoding.
Registry publication and live deployment require separate verification against the pushed commit.

| Check | Measured result |
| --- | --- |
| Node tests | 416 tests passed. |
| Decoder | Stable source-node IDs, cloned skins, local joint overrides and private pose rollback passed. |
| Imported motion | Joint, material and camera tracks retained geometry, maps, skin palettes and canonical recipes. |
| Combined clocks | A valid combined pose bypassed an invalid intermediate weighted skin pose through one transient transaction. |
| Native character | An original astronaut retained nine joints and one embedded texture through actual MCP PNG previews. |
| Native video | Eighteen decoded frames formed a three-second H.264 MP4 with BT.709 metadata and changing character poses. |
| Jobs | Eight stills, layered clip/motion sampling and cancellation preserved the source preview pose and revision. |
| Determinism | Shuffled PNG seeks and checkpoint restoration reproduced exact image bytes. |
| Installed source package | The clean CLI ran modern and legacy SDK calls without development dependencies or source files. |
| Cleanup | Disposal and MCP connection closure exited the installed character CLI. |

The bounded review found one combined-clock defect. A single transient pose transaction removed its causal path.
The source follow-up found no remaining significant findings within its scope.

Square and portrait astronaut frames were inspected. These checks establish recognizable rig authoring, deterministic seeking and bounded CPU export.
They do not establish cinematic character quality, Blender parity or hardware GPU performance.
Facial morph authoring, IK, retargeting and automatic rig creation remain unfinished.

## 0.7.0

Source checks used Windows Node.js, installed Chrome with CPU SwiftShader and FFmpeg H.264 encoding.
Registry publication and live deployment require separate checks against the pushed commit.

| Check | Measured result |
| --- | --- |
| Node tests | 402 tests passed. |
| Motion authoring | Local parent joints, material channels and camera paths sampled without changing authored recipes, revision or topology. |
| Atomicity | Invalid cubic scale, material overshoot, composed graph overflow and camera crossings preserved the previous pose. |
| Native image | The articulated lamp changed pose through actual MCP PNG previews. Shuffled seeks reproduced PNG bytes exactly. |
| Native video | The fixture produced eighteen decoded frames in a three-second H.264 MP4 with BT.709 metadata. First and last frames differed. |
| Jobs | Eight stills, completion and active cancellation preserved a nonzero source preview pose. Checkpoint restore reproduced the initial PNG. |
| Installed package | A clean project omitted development dependencies and source files. Modern and legacy SDK calls retained imported textures, skins and exact undo. |
| Cleanup | The installed motion CLI exited after disposal and MCP connection closure. |

The bounded public contract review found no significant findings within its source scope.

Representative square and portrait lamp frames were inspected.
These fixtures establish deterministic authoring and export behavior. They do not establish cinematic quality or hardware GPU performance.
Imported node-track authoring, motion mixing controls, character asset quality and broader agent modeling tools remain unfinished.

## 0.6.0

Source checks used Windows Node.js, installed Chrome with CPU SwiftShader and FFmpeg H.264 encoding.
Registry publication and live deployment require separate verification against the pushed commit.

| Check | Measured result |
| --- | --- |
| Node tests | 384 tests passed. |
| MCP jobs | The SDK discovered seventeen tools and rendered an eight-frame MP4 with a one-second duration. |
| Animation | Decoded first and last video frames differed. Snapshot output survived a changed catalog file. |
| PNG outputs | One image and eight stills contained valid PNG headers and the requested 128 by 128 dimensions. |
| Source ownership | Render completion and active cancellation preserved source PNG output, revision and retained checkpoints. |
| Cleanup | Closing the MCP connection during a video job exited the server. Reopening retained verified completed results. |
| Storage | Real file tests covered incomplete admissions, failed initial writes, output hashes, quotas, aliases and stale locks. |
| Encoder | The shared pipe encoded a two-second video with eight frames, BT.709 metadata and one pending frame. Cancellation stopped its owned process. |

The public contract review found two storage defects. Atomic admission publication and explicit stale-lock repair removed their causal paths.
The follow-up found no remaining significant findings within that scope.

These checks establish bounded CPU rendering behavior. They do not establish hardware GPU speed or cinematic quality.
Jobs encode silent video. They sample imported clips and renderer time without authoring new animation tracks.

## 0.5.0

Source checks used Windows Node.js and installed Chrome with CPU SwiftShader.
Registry publication and live deployment are verified separately against the pushed commit.

| Check | Measured result |
| --- | --- |
| Node tests | 373 tests passed. |
| Installed CLI | A fresh project installed the archive with development dependencies omitted and scripts disabled. The npm launcher, help and version worked. |
| Protocol | Modern and legacy SDK clients discovered twelve tools and received the package version. Capabilities did not start a browser. |
| Actual rendering | Imported fixtures retained one material texture and one skin. Lighting edits changed PNG output, and undo restored the original PNG exactly. |
| Animation | Sampling an imported clip backward and forward reproduced the same PNG while retaining geometry buffers. |
| Cleanup | Closing the MCP connection with an active scene closed owned preview resources and exited the server process. |
| Consumer | The packed core and addons imported correctly, including an actual physics contact simulation. |
| Licenses | The MCP build reported no missing dependency licenses and recorded output hashes in its manifest. |
| Website | Homepage and agent docs rendered without horizontal overflow or page errors at 1440 and 390 pixels. |

These checks establish CPU preview behavior. They do not establish hardware GPU performance or cinematic quality.
MCP animation track authoring, imported topology changes and persistent video jobs remain unsupported.

## 0.4.0

The source validation used Windows Chrome, ANGLE D3D11 and an RTX 3060.
Publication and deployment require separate registry and live release checks.

| Check | Measured result |
| --- | --- |
| Node tests | 295 tests passed for the complete source before release preparation. |
| Consumer | The packed package imported every addon, including physics, mesh queries and shrinkwrap. |
| Shrinkwrap | All 1,617 source vertices matched the target in nearest and projection modes at landscape and portrait sizes. |
| GPU morph reuse | The computed projection and GPU morph endpoint produced identical pixels. Reverse seeks reproduced the original pixels without graphics errors. |
| Contact query | Both wrapped fixture meshes remained separate from the target in triangle surface queries. This does not certify arbitrary meshes. |
| Query work | Projection used 12,337 triangle callbacks after pruning, compared with 25,416 before pruning on the same fixture. |
| Nearest query | 96 queries on a 4,992-triangle fixture matched exhaustive scan distances and points exactly. |
| Build | The library, website and clean packed consumer passed. |

Nearest query timings were 45.07 ms for index construction and 9.40 ms for 96 queries.
An exhaustive scan took 33.43 ms for the same queries.
These fixture measurements do not prove a general performance advantage over Three.js.
Build the index once and reuse it.

Shrinkwrap accepts static geometry and preserves topology. Clearance applies at vertices and does not guarantee separation over entire triangles.
Physics recordings do not provide humanoid ragdoll binding. Transparent materials, compressed meshes and ray tracing remain unsupported.
The procedural scientist still needs a recognizable face and improved cinematic presentation.

## 0.3.3

These checks used Windows Chrome, ANGLE D3D11 and an RTX 3060.

| Check | Measured result |
| --- | --- |
| Node tests | 78 tests passed, including articulated joints, forward track contact, deterministic film motion and assembly interpolation. |
| Assembly | Native slider taps and interrupted transitions passed at 1440, 390 and 320 pixels. Driving remained paused until complete reassembly. |
| Motion preferences | Reduced motion snapped assembly to the selected position and kept driving paused. |
| Moving character | Head, arms and claws rendered correctly at four poses. Camera and shadow bounds followed the root at 120 seconds. |
| Film transport | Held pointer input, coalesced seeks, delayed audio, keyboard input and paused seeking passed. Real playback resumed without moving behind the selected time. |
| Terrain | Film sand and nature terrain compiled and rendered without WebGL errors. |
| Trailer | Sixteen inspected frames cover the rebuilt machinery, silhouettes, jeep, desert, night lighting and ignition. |
| Full export | 4,488 frames at 1280 × 720 and 24 FPS rendered in 110.13 seconds. The film lasts 187 seconds. |
| Memory | The export kept one pending frame. Peak renderer allocation was 84.34 MiB, observed Node RSS was 217.34 MiB and sampled browser heap was 19.42 MiB. |
| Delivery | FFprobe verified H.264, BT.709, 48 kHz stereo AAC and 187 seconds. The delivery file contains 22,729,620 bytes. |

The export used JPEG capture at quality 95 and NVENC encoding.
The browser player renders the same procedural scene directly through WebGL.
The downloadable file uses a lower bitrate to fit the hosting asset limit.
Its encoded Gadget closeup was inspected after compression.

Renderer estimates exclude driver memory and browser RSS.
The figures remain stylized silhouettes, without photorealistic character assets or recorded performances.

## 0.3.0

The package is `@codepawlhq/67js`, installed locally through the `67js` alias. The display name remains 67js.

| Check | Measured result |
| --- | --- |
| Node tests | 64 tests passed, including ordered and reverse-index hierarchy limits, relative resource paths and negotiated sample reporting. |
| Consumer | A clean project installed the archive and imported the core plus all six addons. |
| HDR and effects | Hardware WebGL negotiated RGBA16F targets. Bloom and color grading changed pixel checksums without graphics errors. |
| Determinism | Out-of-order motion seeks reproduced exact pixel checksums. |
| Resource reuse | Eighty motion updates created zero additional buffers, textures, framebuffers or renderbuffers. |
| Standard assets | An imported GLB displayed two distinct base-color textures and reproduced absolute node animation seeks. |
| Views | Flat XY geometry and front, top, right and perspective model views rendered without graphics errors. |
| CPU | SwiftShader rendered the HDR motion scene and encoded a square 2D clip through libx264. |
| Video | Landscape and portrait motion exports each contain 144 H.264 frames over 12 seconds. Imported GLB animation contains 24 frames over two seconds. |
| Capture queue | Every tested video kept one pending frame and remained within its configured allocation estimate. |
| Regression | WALL·E assembly, layers, exports, benchmark pixel agreement, keyboard controls and context restoration passed. |
| Layout | New studios rendered at 1440, 390 and 320 pixels without horizontal overflow. |

The tested hardware was an RTX 3060 through ANGLE D3D11. Software rendering used Chrome ANGLE SwiftShader.
The allocation figures estimate renderer targets, geometry, textures and capture staging. They do not measure total driver VRAM or browser RSS.

Source review found three issues: mismatched capture samples, unnormalized glTF resource URLs and hierarchy limits that depended on node ordering.
Constructor options now select capture samples, and sample reporting follows the negotiated allocation count.
Resource lookup normalizes URLs, and hierarchy validation visits roots before descendant nodes. Regression tests cover all three paths.

## Historical 0.2.0 checks

The early archive used the unscoped `67js` name before npm rejected that name. The scoped organization package supersedes it.

| Check | Measured result |
| --- | --- |
| Node tests | 24 tests passed, including all 574 detail offsets and unchanged assembled geometry. |
| Consumer installation | A clean temporary project installed the archive and imported the core and all three addons. |
| Package size | The archive contains code and documentation. It is below 100 KB and excludes preview media. |
| Browser download | A standalone module imported from a Blob URL and rendered a cube without graphics errors. |
| Slider | Assembly round trip, allocation reuse, layers and exploded GLB translations passed. |
| Homepage and guide | Rendered at 1440, 390 and 320 pixels without page overflow. |
| Deep link | The exploded preview opens the studio with the slider at 100%. |
| GPU preview | The 1440 × 900 export used four MSAA samples and reported no WebGL errors. |
| Cloudflare configuration | Wrangler's deployment dry run passed. |

The review covered the homepage, guide and object viewer against commit `32aa19c`.
It excluded generated bundles, lockfiles and binary images from source review.
Layout and accessibility checks covered native controls, focus styles, labels, release states and narrow views.
Screen-reader operation, RTL and browser zoom were not verified.
There were no remaining actionable interface findings within the inspected coverage.

Source review found that the browser download omitted shared chunks.
A separate, single-entry browser bundle fixed that issue. The downloaded-module check passed after the fix.

Release metadata is generated from the package version and Git commit.
Deployment requires a clean checkout and the same commit on `origin/main`.
The deployment script checks the live version, commit and package integrity after upload.
