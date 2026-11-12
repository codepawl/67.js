# Data-only packs

A pack is a folder of material sets, recipes, looks, HDRIs and GLB models with a manifest and no code. Someone shares it as a zip, you unzip it into a local folder, and 67js checks it when the MCP server starts. Nothing in a pack runs, and nothing is downloaded by a tool call.

## Make a pack

```
my-pack/
  67js-pack.json
  models/crate.glb
  textures/brick.png
  looks/warm.cube
  hdri/studio.hdr
  materials/rusty-metal.json
  recipes/workshop.json
  previews/workshop.png
```

`67js-pack.json` at the root:

```json
{
  "format": "67js.pack", "schemaVersion": 1,
  "name": "my-pack", "version": "1.0.0", "engines": { "67js": ">=0.19.0" },
  "license": "CC0-1.0", "author": "Your Name", "description": "One line about the pack.",
  "contents": {
    "assets":       [{ "id": "crate", "file": "models/crate.glb" }],
    "images":       [{ "id": "brick-albedo", "file": "textures/brick.png" }],
    "looks":        [{ "id": "warm", "file": "looks/warm.cube" }],
    "environments": [{ "id": "studio", "file": "hdri/studio.hdr" }],
    "materials":    [{ "id": "rusty-metal", "file": "materials/rusty-metal.json" }],
    "recipes":      [{ "id": "workshop", "file": "recipes/workshop.json", "preview": "previews/workshop.png" }]
  }
}
```

| Kind | Files | What it is |
| --- | --- | --- |
| `assets` | `.glb` | Self-contained GLB, the same files `--assets` takes |
| `images` | `.png` `.jpg` `.jpeg` `.webp` | Map images and sequence frames |
| `looks` | `.cube` | 3D colour look (`LUT_3D_SIZE`) |
| `environments` | `.hdr` | Radiance HDRI |
| `materials` | `.json` | One material object, the fields of a `materials` entry in a recipe |
| `recipes` | `.json` | A full recipe, as `scene_create` takes it; `preview` is an optional image |

Rules, all checked at load:

- Keys are known ones only. `name` and ids are kebab-case; ids are unique per kind. `version` is three numbers. `engines["67js"]` is a range of space-separated comparators (`>=`, `>`, `<`, `<=`, `=`, `^`, `~`, such as `>=0.19.0 <1`) that the installed 67js satisfies.
- Paths are relative, with forward slashes, inside the pack: no `..`, no absolute or drive paths, no backslashes, only letters, digits, `.`, `_` and `-` in each part. Every listed file must exist and have the extension of its kind.
- No symbolic links, and no script or program file anywhere in the pack, listed or not (`.js`, `.mjs`, `.html`, `.svg`, `.wasm`, `.exe`, `.sh`, `.bat`, `.ps1`, `.py` and similar). One such file refuses the whole pack.
- Limits (`src/pack-manifest.js`): 256 files, 256 MiB in total, 64 MiB per file, 1 MiB per JSON file, 64 items per kind; at most 32 packs load at once.
- Recipes and materials contain no remote URL (`http:`, `https:`, `ftp:`, `//host`, a `data:` URL that is not a PNG, JPEG or WebP image). A recipe has `"format": "67js.scene"`. `npm run pack:check` also runs the validator `scene_create` uses (a material is checked as the only material of an empty scene); the server leaves that to `scene_create` and `scene_apply`, which run it when the agent uses the item.

An error names the pack, the file and the field, and says what to pass instead.

## Validate

```sh
npm run pack:check -- path/to/my-pack
```

It runs the same checks as the server and prints `ok` or `FAIL` with the error. The repository ships `packs/example-starter/` (CC0) as a template to copy.

## Install

Unzip each pack into its own subfolder of one packs folder and start the server with that folder:

```sh
67js-mcp --packs /absolute/path/to/packs
```

A pack that fails the checks is skipped and listed with its error under `packs.rejected` in `scene_asset_catalog`; the others still load. Changed files need a server restart, like `--assets`.

## Use from an agent

`scene_asset_catalog` lists each pack's name, version, license, author, description and item ids. GLBs, images, looks and HDRIs carry the same SHA-256 `assetId` as `--assets` files (they also appear in the main `assets` list), so `scene_create_asset`, the `look` and `hdri` fields and texture sequences use them unchanged. For a material or recipe, call `scene_asset_catalog` with `{ "pack": "my-pack", "recipe": "workshop" }` or `{ "pack": "my-pack", "material": "rusty-metal" }` to read its JSON, then pass it to `scene_create` or use it as a `materials` entry. `scene_capabilities` topic `packs` has the limits.

## Publish

Zip the pack folder with `67js-pack.json` at the top of the archive, name the zip `name-version.zip` and host it anywhere, such as a GitHub release. State the license of every file in `license` and in a `LICENSE` file; 67js does not check licenses. Run `npm run pack:check` first, and say which 67js versions you tested.
