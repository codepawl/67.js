- entry:coplanar-overlap: cutting hidden flush faces (flush-clip.js: subtract the covering triangle, interpolate the vertex arrays, give every seam vertex to both sides of its edge), +3584 bytes gzip on top of step 1 (7880 to 11464); an addon chunk, loaded by agent scenes and by renderers that pass resolveCoplanar; it is what settles stacks deeper than the 16 ranks and gives the path tracer one face per plane
- entry:core: the renderer draws a cut geometry beside the part and the path tracer reads it, +45 bytes gzip on top of step 1 (85679 to 85724)
- scene:lit-box: same core growth (+52 bytes gzip); accepted for flicker-free rendering
- scene:gltf-box: same core growth (+51 bytes gzip); accepted for flicker-free rendering
- scene:gltf-box+lazy: same core growth; accepted for flicker-free rendering
- scene:agent-scene: same core growth (+71 bytes gzip); accepted for flicker-free rendering
- scene:agent-scene+lazy: the core growth plus the larger flush chunk; it is the fix, so it has to load
- goal:lit-box: the growth is the cut-geometry lookup in the core; accepted for flicker-free rendering
- goal:gltf-box: the growth is the cut-geometry lookup in the core; accepted for flicker-free rendering
- goal:agent-scene: the growth is the cut-geometry lookup in the core; accepted for flicker-free rendering

Measured in Node on the Melbourne drape map (9,718 pairs, 6,543 of them on one plane), one run on a loaded machine:
the flush pass takes 1.4 s where the search alone takes 0.9 s, and 0.7 s on a second run of the unchanged scene (cuts and orders are kept);
cut parts draw from their own copy of the vertex arrays: walls 110,368 to 119,988 vertices, glass 20,360 to 23,970, roofs 48,901 to 49,693, canopy 82,848 to 82,886, about 9 MB at 32 bytes a vertex (inferred from the counts, not read from the renderer);
triangles drawn: walls 55,184 to 62,547, glass 10,180 to 13,154, roofs 38,116 to 38,927, canopy 138,080 to 138,128.
Frame time and draw calls were not measured for this step.
Tool cost: no schema or result grew.
