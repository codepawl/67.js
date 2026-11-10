- entry:core: the depth rank (a view-space bias in the vertex shader, ranked index ranges in the draw loop) lives in the core, +494 bytes gzip (85185 to 85679); it is what makes decals and flush faces separate the same way on every depth format
- entry:coplanar-overlap: the triangle-level flush search and the rank resolver, +3848 bytes gzip (4032 to 7880); an addon chunk, loaded by agent scenes and by renderers that pass resolveCoplanar
- scene:lit-box: same core growth (+483 bytes gzip); accepted for flicker-free rendering, optimisation later
- scene:gltf-box: same core growth (+509 bytes gzip); accepted for flicker-free rendering, optimisation later
- scene:gltf-box+lazy: same core growth (+509 bytes gzip); accepted for flicker-free rendering, optimisation later
- scene:agent-scene: same core growth plus the leftover report wiring (+749 bytes gzip); accepted for flicker-free rendering, optimisation later
- scene:agent-scene+lazy: the core growth plus the larger flush search chunk; it is the fix, so it has to load
- goal:lit-box: the growth is the depth rank code in the core; accepted for flicker-free rendering, optimisation later
- goal:gltf-box: the growth is the depth rank code in the core; accepted for flicker-free rendering, optimisation later
- goal:agent-scene: the growth is the depth rank code in the core; accepted for flicker-free rendering, optimisation later

Measured on the Melbourne drape map (282,399 triangles, 9 parts; RTX 3060 through Chrome, 1920x1080, 4 samples):
search and ranking once per parts change 0.9 to 1.4 s in Node (16,751 pairs on the drape file, 108,955 on the flat file); the search holds about 21 MB of typed arrays per 282k triangles while it runs (144 MB at the 2 M triangle budget);
one ranked index copy per affected batch, 3.2 MB on the CPU and +2.76 MiB of GPU index buffers (geometry 13.52 to 16.29 MiB);
draw calls 9 to 40 (walls 12 ranges, glass 15, roofs 6, canopy 2);
frame time 1.11 to 1.24 ms without ranks and 1.15 to 1.22 ms with ranks (median of 5 rounds of 60 frames ended by a readPixels, two runs, two views): no difference outside the noise.
Tool cost: no schema or result grew (`npm run tool-cost`); the detail sits in the depthBias topic of scene_capabilities.
