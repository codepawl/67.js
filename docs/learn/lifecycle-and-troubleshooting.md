# Lifecycle and troubleshooting

This page lists the problems that new users meet most often. Each section starts with what you see, then gives the cause and the fix. Most errors from Crucible name the part or the value that failed, so read the full message in the browser console first.

## The canvas stays empty

- **The canvas has no size.** The renderer reads the CSS size of the canvas. A canvas inside an element with no height is 0 pixels high. Give the canvas or its parent a height in CSS, as in [step 1 of the tutorial](#first-scene/add-a-canvas).
- **Nothing calls `render`.** `new CrucibleRenderer()` uploads the parts but does not draw. Call `renderer.render(frame)` after you make the renderer, and again after each `resize()`.
- **The camera looks away from the parts.** Put `target` near the parts, and keep `eye` outside them. Start with `eye: [3, 2, 4]` and `target: [0, 0.5, 0]`.
- **The parts are too small or too large.** `box()` has sides of 1 and `sphere()` has a radius of 1. A model in centimeters can be 100 times larger than you expect. [Load a GLB file](#import-and-export-models/load-a-glb-file) frames a model from its size.

## Error: WebGL2 is unavailable

The full message is `WebGL2 is unavailable. Enable hardware acceleration or use a supported browser.` Turn on hardware acceleration in the browser settings, or update the graphics driver. A current Chrome, Edge, Firefox or Safari has WebGL2. CPU export from a checkout can use SwiftShader, a software renderer, instead of a graphics card.

## Error: Invalid transform or Singular transform

`Invalid transform: Cube` means that the matrix of the part named Cube does not have 16 finite numbers. `Singular transform: Cube` means that the matrix cannot be inverted, for example because a scale is 0. Use a very small scale such as `0.0001` to hide a part, or leave the part out.

## Error: Unknown part identity

`updateParts` changes the matrices and the materials of parts that the renderer already has. A new part object, or a part that the renderer did not get at construction, causes this error. Change the fields of the existing part objects, as in [step 5 of the tutorial](#first-scene/animate-the-cube). To add or remove parts, make a new renderer, or call `renderer.replaceParts(parts)` for rigid parts without textures.

## Error: Memory budget cannot hold

The renderer estimates the memory of the geometry, the textures and one frame before it allocates them. If the estimate is over `memoryBudgetMiB`, the error names each amount and the budget that fits. Pass that budget, or make the scene smaller:

1. Lower the resolution with a smaller `pixelRatio`.
2. Lower `samples`, the antialiasing count.
3. Use smaller textures, and share geometry and texture descriptors between parts.

The estimate is an allocation budget, not a hard limit on the memory of the process.

## Colors look washed out or too bright

`color` is linear RGB. A value copied from a CSS color looks too light. Convert it as shown in [Colors are linear](#materials-and-color/colors-are-linear). If highlights are pure white, lower `exposure` and the bloom `strength`, and check that no `color` value is above 1.

## Edges look jagged

Read `renderer.memoryPlan` for the real width and height of the drawing, and `renderer.capabilities.samples` for the antialiasing count that the device accepted. Raise `pixelRatio` only while the memory plan stays inside the budget.

## A model does not load

The glTF importer refuses a file that it cannot read correctly, and the error names the feature or the limit. It does not draw a different model in its place. Convert the file to the supported subset, for example with `npx @gltf-transform/cli`. The [asset contract](/gltf.md) lists the supported features and the limits. Show the error to the user, and do not swap in another asset without a message.

## The page loses the WebGL context

A browser can drop the WebGL context when the graphics driver resets or when too many pages use WebGL. Stop the playback, call `dispose()` on the renderer, and make a new renderer when the browser fires `webglcontextrestored` on the canvas.

## A feature in these docs is missing

The site shows the current source, which can be newer than the npm release. Compare `VERSION` from `import { VERSION } from 'crucible'` with the [release metadata](/release.json), and read the [changelog](/changelog.html) for the version that adds the feature.

## Clean up a scene

When a page or a component goes away, release everything that the scene holds:

1. Disconnect the `ResizeObserver`.
2. Cancel the animation frame request.
3. Release the pointer capture and remove the listeners.
4. Call `renderer.dispose()`.
5. Call `asset.dispose()` for each loaded GLB asset, after the renderer.

[Step 6 of the tutorial](#first-scene/clean-up) has the code.
