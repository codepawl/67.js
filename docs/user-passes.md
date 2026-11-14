# User post-process passes

A scene can add its own full-screen passes: a GLSL fragment that reads the finished frame, the depth and a normal, and writes a new frame. Use it for a pixel-art downscale, an ordered dither, a colour quantise, an outline of your own or a PS2-style look.

The same field works from three places: the `crucible/addons/user-pass` addon, the `postPasses` section of a recipe, and MCP (`scene_create`, `scene_apply` with `set-post-passes`). MCP accepts no host JavaScript. It accepts GLSL fragment snippets that pass a strict check before anything compiles; the rules are below.

## Where a pass runs

Passes run in order on the finished frame: after depth of field, motion blur, line art, bloom, grading and the view transform, as the last step before the canvas. The first pass reads the frame as it would have been shown. Each next pass reads the one before. Colours are display-referred (0 to 1), so quantising and dithering work on the values people see. The path tracer does not apply passes. Render passes (`pass: 'depth'` and the others) and the water mirror are unaffected.

## A pass

```json
{ "name": "pixel-dither", "scale": 0.25, "uniforms": { "levels": 4 }, "fragment": "vec4 userPass(vec2 uv) { ... }" }
```

| Field | Meaning |
| --- | --- |
| `name` | Lowercase letter, then letters, digits or hyphens, 32 characters at most. Unique in the scene. |
| `fragment` | GLSL ES 3.00 text that defines `vec4 userPass(vec2 uv)`. Helper functions and `const` values may come before it. 4096 bytes at most. |
| `uniforms` | Named values. A number is a `float`; `[x, y]`, `[x, y, z]` and `[x, y, z, w]` are `vec2`, `vec3` and `vec4`; an int is `{ "type": "int", "value": 4 }`. |
| `scale` | 0.05 to 1 (default 1). The pass renders at this fraction of the width and height, and whatever reads it enlarges it with nearest filtering. A `scale` of 0.25 on the last pass is a pixel-art downscale. |
| `objects` | Optional list of 1 to 16 part names (node ids, as the object ID pass lists them). `objectSlotAt(uv)` tells which of them is under a pixel. The preview and render jobs draw the object ID pass first when a pass lists parts. |

You do not declare uniforms or the version line; the engine writes them. A snippet sees these names:

| Name | Type | Meaning |
| --- | --- | --- |
| `sceneColor` | `sampler2D` | The frame, or the previous pass. |
| `sceneDepth` | `sampler2D` | Depth of the scene, at full size. It needs `depth: true` on the renderer (the MCP preview has it); without it every sample reads 1. |
| `resolution` | `vec2` | Size of this pass in pixels. |
| `time` | `float` | Frame time in seconds. |
| `depthAt(uv)`, `worldPointAt(uv)` | functions | Raw depth, and the world position of the pixel. |
| `worldNormalAt(uv)` | function | The surface normal, found from neighbouring depth samples. It is exact on flat faces and wrong at silhouettes and in the sky. |
| `objectSlotAt(uv)` | function | The position in the pass's `objects` list of the part under `uv`, or -1 for the background, any other part, and a pass with no `objects`. A name that matches several parts gives all of them its one position. Edges are hard: an object ID cannot be antialiased. A name that is not a part in the frame fails the render and lists part names to use. |
| `gl_FragCoord` | `vec4` | The pixel position inside this pass. |

## Limits and rules

The check runs on the text before any compile. A snippet that breaks a rule is refused with the line, the column and a fix.

- At most 4 passes, 4096 bytes per snippet, 16 uniforms per pass. Uniform names match `^[a-z][A-Za-z0-9]{0,31}$`, are not GLSL keywords and do not reuse an input name. Values are finite numbers.
- No `#` lines (no `#define`, `#extension`, `#version`). No backslash, and ASCII text only.
- No `while` or `do`. A `for` loop has the exact form `for (int i = 0; i < 8; i++) { ... }`: a counter that starts at an integer literal, a test against an integer literal, a step of `i++`, `++i`, `i--`, `--i`, `i += N` or `i -= N`, and a body in braces. It runs 64 iterations at most, and the body does not change the counter.
- Loop work stays under 4096 iterations per pixel: nested loops multiply, and a call to your own helper counts that helper's loops again.
- No `uniform`, `layout`, `attribute`, `varying` or `buffer` declarations.
- No name that starts with `gl_`, except `gl_FragCoord`. No name that starts with `u67_`; the engine keeps that prefix.

## JavaScript

```js
import { installUserPasses } from '@codepawlhq/crucible/addons/user-pass';

installUserPasses(renderer); // needs depth: true for sceneDepth
renderer.userPasses.set([{ name: 'soft', uniforms: { amount: 0.5 }, fragment: `
  vec4 userPass(vec2 uv) {
    vec3 color = texture(sceneColor, uv).rgb;
    return vec4(mix(color, vec3(dot(color, vec3(0.299, 0.587, 0.114))), amount), 1.0);
  }` }]);
renderer.userPasses.set([]); // remove them
```

`set` can run every frame. New uniform values do not recompile; a new `fragment` compiles on the next frame. A compile or link error throws from that frame's `render` as an `Error` that carries the driver's log with line numbers mapped to your snippet. The same checks apply as for a recipe, so a snippet that works here works in a recipe.

## Recipe and MCP

```json
{ "postPasses": [ { "name": "pixel-dither", "scale": 0.25, "uniforms": { "levels": 4, "spread": 1 }, "fragment": "..." } ] }
```

`scene_create` takes `postPasses`. `scene_apply` takes `{ "type": "set-post-passes", "postPasses": [...] }`; `null` or `[]` clears it. `scene_inspect` lists the passes (name, scale, uniform names with types, snippet size). `scene_capabilities` reports the same limits under `postPasses`. `scene_look` and `scene_render_submit` draw the passes.

## Errors

Each message names the pass, the position and a fix:

```text
Post pass "pixel-dither" fragment line 4, column 3: "while" loops are not allowed. Fix: Use a for loop with integer literal bounds of at most 64, for example for (int i = 0; i < 8; i++) { ... }.
Post pass "pixel-dither" fragment line 2, column 1: Preprocessor lines (#) are not allowed. Fix: Remove the # line; write constants as const float name = value; and use plain code instead of #define.
Post pass "pixel-dither" fragment line 3, column 25: This for loop runs more than 64 iterations. Fix: Lower the bound or raise the step so the loop runs at most 64 times.
```

A snippet that passes the check can still fail the compiler. In MCP the edit is kept, the result has `renderSucceeded: false` and `renderError` holds the log, and the session stays usable: send `set-post-passes` again with the fix.

```text
Post pass "pixel-dither" failed to compile as GLSL ES 3.00. Line numbers refer to your fragment snippet.
ERROR: snippet line 7: '=' : dimension mismatch
    | vec3 wrong = 1.0;
ERROR: snippet line 7: '=' : cannot convert from 'const float' to 'highp 3-component vector of float'
    | vec3 wrong = 1.0;
```

## Worked example: ordered dither with a pixel downscale

The pass renders at a quarter of the width and height, mixes a 4x4 Bayer threshold into the colour, rounds each channel to `levels` steps, and is enlarged with nearest filtering. The blocks are 4x4 screen pixels and the frame has at most `levels` values per channel.

```glsl
// Ordered 4x4 dither, then colour steps. The pass renders at a quarter size, so one dither cell is a chunky pixel.
const float bayer[16] = float[16] (0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);

vec4 userPass(vec2 uv) {
  vec3 color = texture(sceneColor, uv).rgb;
  ivec2 cell = ivec2(gl_FragCoord.xy) & 3;
  float threshold = (bayer[cell.y * 4 + cell.x] + 0.5) / 16.0 - 0.5;
  vec3 stepped = floor(color * (levels - 1.0) + 0.5 + threshold * spread) / (levels - 1.0);
  return vec4(clamp(stepped, 0.0, 1.0), 1.0);
}
```

As a recipe section:

```json
{"postPasses":[{"name":"pixel-dither","scale":0.25,"uniforms":{"levels":4,"spread":1},"fragment":"// Ordered 4x4 dither, then colour steps. The pass renders at a quarter size, so one dither cell is a chunky pixel.\nconst float bayer[16] = float[16] (0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);\n\nvec4 userPass(vec2 uv) {\n  vec3 color = texture(sceneColor, uv).rgb;\n  ivec2 cell = ivec2(gl_FragCoord.xy) & 3;\n  float threshold = (bayer[cell.y * 4 + cell.x] + 0.5) / 16.0 - 0.5;\n  vec3 stepped = floor(color * (levels - 1.0) + 0.5 + threshold * spread) / (levels - 1.0);\n  return vec4(clamp(stepped, 0.0, 1.0), 1.0);\n}"}]}
```

`levels` of 2 gives a one-bit look, 8 a soft one. `spread` of 0 turns the dither off and leaves plain steps.

# Material fragment hook

A material can carry its own fragment code: a GLSL function that changes the surface colour and alpha, or discards the fragment. Use it for a dissolve, a shoreline cut from a mask, a leaf cutout or a stripe pattern. It works from the `snippet` field of a recipe material and from MCP (`scene_create`, `scene_apply` with `set-material`; `snippet: null` clears it). It follows the same rules as a post pass, and MCP accepts no host code.

```json
{ "id": "stone", "color": [0.5, 0.5, 0.5], "snippet": { "fragment": "...", "uniforms": { "threshold": 0.4 }, "mask": "map" } }
```

| Field | Meaning |
| --- | --- |
| `fragment` | GLSL ES 3.00 text that defines `void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition)`. Helper functions and `const` values may come before it. 4096 bytes at most. |
| `uniforms` | Named values, as for a post pass: a number is a `float`, `[x, y]` to `[x, y, z, w]` are vectors, `{ "type": "int", "value": 4 }` is an int. At most 16. |
| `mask` | Optional, `"map"`: the snippet may sample `snippetMask` (a `sampler2D`), which is the material's own map or pattern. Load the image as the material `map`; there are no remote URLs. |

Inputs: `color` is the base colour after the map and the vertex tint, `alpha` is the map alpha before the material opacity, `uv` is the texture coordinate and `worldPosition` the position in the world. `discard` removes the fragment in every alpha mode. A lowered `alpha` cuts only when the material has `alphaMode: "mask"`.

## Where the hook runs

The hook runs in the colour pass, in the shadow pass and in the ID pass. A discarded fragment therefore casts no shadow and is not picked. In the shadow pass `color` starts white and `alpha` is the map alpha, so base a discard on `alpha`, `uv`, `worldPosition` and your uniforms, not on `color`. The path tracer and exports ignore the hook. Changing a snippet makes the MCP preview build a new renderer, so edit it between looks, not in a loop.

The rules are the ones of [a pass](#limits-and-rules): no `#` lines, no `while` or `do`, counted `for` loops only, no `gl_` names but `gl_FragCoord`, no `u67_` names. Errors name the material's parts, the line, the column and a fix. A snippet that passes the check but fails the compiler comes back as `renderError` with the log mapped to snippet lines, and the session stays usable:

```text
Material snippet (used by caster) failed to compile as GLSL ES 3.00. Line numbers refer to your fragment snippet.
ERROR: snippet line 3: '=' : dimension mismatch
    | vec3 wrong = 1.0;
```

## Worked example: dissolve a wall with a noise threshold

The wall breaks into hash cells; a cell is removed when its noise value is below `threshold`, and cells near the edge glow orange. Moving `threshold` from 0 to 1 dissolves the wall, and the shadow of the wall dissolves with it.

```glsl
float cellNoise(vec2 cell) { return fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453); }

void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {
  float value = cellNoise(floor(worldPosition.xy * 6.0));
  if (value < threshold) discard;
  float edge = 1.0 - smoothstep(0.0, 0.08, value - threshold);
  color = mix(color, glow, edge);
}
```

```json
{ "type": "set-material", "id": "wall", "snippet": { "uniforms": { "threshold": 0.35, "glow": [1.0, 0.45, 0.1] }, "fragment": "float cellNoise(vec2 cell) { return fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453); }\n\nvoid materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {\n  float value = cellNoise(floor(worldPosition.xy * 6.0));\n  if (value < threshold) discard;\n  float edge = 1.0 - smoothstep(0.0, 0.08, value - threshold);\n  color = mix(color, glow, edge);\n}" } }
```

For a leaf or shoreline cutout, give the material a `map` whose alpha or red channel holds the mask, set `"mask": "map"` and write `if (texture(snippetMask, uv).r < 0.5) discard;`.
