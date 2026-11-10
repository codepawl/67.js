The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

The notice above covers the decal clipping in the surface addon, which follows three.js DecalGeometry.

## highlight.js 11.12.0 (website syntax highlighting)

BSD 3-Clause License

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Built files

Each file in `build/` starts with a one-line notice that points here and to `LICENSE`. The complete texts are kept once, in those two files.

## MCP command and browser preview

The packaged `build/mcp/server.mjs` and `build/mcp/preview.js` bundle the MCP SDK,
schema validation and rendering dependencies. `build/mcp/LICENSES.md` contains
their complete license and notice texts, including dependencies embedded in the SDK.
`build/mcp/manifest.json` records dependency versions, license provenance and output SHA-256 hashes.
Pinned upstream license copies for embedded dependencies are retained in `licenses/mcp/` in the source repository.
The external `playwright-core` browser driver includes its own license and notices in its dependency package.

## RobotExpressive (test fixture, not in the npm package)

`tests/fixtures/RobotExpressive.glb` is by Tomás Laulhé, with modifications by Don McCurdy, from the three.js examples, under CC0-1.0.

## Simple Icons (package-manager logos)

The npm, pnpm, Yarn and Bun SVG marks are sourced from Simple Icons and distributed under CC0-1.0. See public/licenses/simple-icons.txt. Brand marks remain subject to their respective trademark rights.

## Manifold 3.5.4 (optional mesh boolean peer dependency)

The mesh addon loads `manifold-3d` as a separate dependency for booleans.
Manifold is distributed under the Apache License, Version 2.0.
Its dependency package includes the complete license text.
Manifold's JavaScript and WASM code are not bundled into the 67js library archive.
The MCP runtime serves them to its preview page from the installed peer dependency.
Source and license: https://github.com/elalish/manifold.

## Rapier 3D 0.21.0 (optional physics peer dependency)

The physics addon loads `@dimforge/rapier3d-compat` as a separate dependency.
Rapier is distributed under the Apache License, Version 2.0.
Its dependency package includes the complete license text.
Rapier's JavaScript and WASM code are not bundled into the 67js library archive.
Source and license: https://github.com/dimforge/rapier.js.

## DejaVu Sans 2.37 (3D text outlines, `src/font-default.js`)

`src/font-default.js` holds the outlines of the printable ASCII characters of DejaVu Sans, extracted by `scripts/build-font.py`.
They load on demand with the text geometry. Fonts are (c) Bitstream; changes by DejaVu are in the public domain.
Only the Bitstream Vera and DejaVu glyphs of Basic Latin are used. The data is not renamed or edited, so the Vera licence applies as written:

Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved. Bitstream Vera is a trademark of Bitstream, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of the fonts accompanying this license ("Fonts") and
associated documentation files (the "Font Software"), to reproduce and distribute the Font Software, including without limitation
the rights to use, copy, merge, publish, distribute, and/or sell copies of the Font Software, and to permit persons to whom the
Font Software is furnished to do so, subject to the following conditions:

The above copyright and trademark notices and this permission notice shall be included in all copies of one or more of the Font
Software typefaces.

The Font Software may be modified, altered, or added to, and in particular the designs of glyphs or characters in the Fonts may be
modified and additional glyphs or characters may be added to the Fonts, only if the fonts are renamed to names not containing either
the words "Bitstream" or the word "Vera".

This License becomes null and void to the extent applicable to Fonts or Font Software that has been modified and is distributed
under the "Bitstream Vera" names.

The Font Software may be sold as part of a larger software package but no copy of one or more of the Font Software typefaces may be
sold by itself.

THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT
SHALL BITSTREAM OR THE GNOME FOUNDATION BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL, INDIRECT,
INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY
TO USE THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.

Except as contained in this notice, the names of Gnome, the Gnome Foundation, and Bitstream Inc., shall not be used in advertising or
otherwise to promote the sale, use or other dealings in this Font Software without prior written authorization from the Gnome
Foundation or Bitstream Inc., respectively. For further information, contact: fonts at gnome dot org.

Source: https://dejavu-fonts.github.io/ (version 2.37).


## HDRI environments in assets/looks

`sky-clouds.hdr` and `studio-softbox.hdr` are 128 x 64 area averages of the 1k Poly Haven HDRIs `kloofendal_48d_partly_cloudy_puresky` and `studio_small_03`, published under CC0 1.0 (https://polyhaven.com/license). `teal-orange.cube` and `noir.cube` were made for 67js and are CC0.
