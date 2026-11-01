# Third-party components and format references

- Three.js 0.180.0: https://github.com/mrdoob/three.js — MIT. Installed locally
  through npm; its license is in `node_modules/three/LICENSE`.
- PyCryptodome: https://www.pycryptodome.org/ — BSD/public-domain components.
  Installed in the project virtual environment.
- Pillow: https://python-pillow.org/ — MIT-CMU/HPND and bundled library notices.
  Used for library artwork; installed in the project virtual environment.
- vgmstream r2168 Windows x64: https://github.com/vgmstream/vgmstream — ISC and
  bundled codec licenses. The original distribution and its `COPYING` file are
  retained under `.tools/vgmstream/`. The launcher downloads the official release.
- RS2IR Converter by Jeremy Terhune:
  https://github.com/jermn007/rs2ir-converter — MIT. Its PSARC and SNG layout
  explanations informed `importers.py`; its notice is retained in
  `LICENSE-RS2IR.txt`. The complete converter is not a runtime dependency.
- RocksmithToolkit: https://github.com/rscustom/rocksmith-custom-song-toolkit —
  reference for Rocksmith 2014 chart layout and phrase difficulty semantics.
- ToneLib `.song` archive/XML knowledge comes from the adjacent Transcriber V3
  project's generated archives. ToneLib does not publish a format specification;
  only the documented subset is supported here.

No recordings or song archives are bundled with the application.

Portable builds include Python, Pillow, PyCryptodome and Three.js notices under
`licenses/`, including Python's bundled-component notices. The vgmstream
distribution and its notices are under `_internal/.tools/vgmstream/`.
PyInstaller (https://pyinstaller.org/) is a build-only dependency; its bootloader
exception permits redistribution of the generated application.
