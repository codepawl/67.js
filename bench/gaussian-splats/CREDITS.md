# Credits

`node bench/gaussian-splats/fetch-sample.mjs` downloads one splat scene into `bench/gaussian-splats/data/`, a folder git ignores. No splat file is committed.

| Scene | Author | Source | Licence |
| --- | --- | --- | --- |
| millipede spec. (`millipede.splat`, 116,374 splats, 3.7 MB) | Fabian Plum ([scant3d](https://superspl.at/user?id=scant3d)) | [superspl.at/scene/3d5482d4](https://superspl.at/scene/3d5482d4), through `examples/models/splat/millipede.splat` of the [three.js repository](https://github.com/mrdoob/three.js) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): the author must be credited, commercial use is allowed |

The script rewrites the 32-byte `.splat` records as a standard 3DGS PLY (`millipede.ply`, 6.5 MB) so that Crucible and three.js load the same bytes. The conversion keeps colour and opacity to 8 bits, as the source has them.
