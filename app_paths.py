"""Bundled resources and persistent state for source and portable launches."""

import sys
from pathlib import Path


RESOURCE_ROOT = Path(__file__).resolve().parent
# PyInstaller puts resources in _internal; user data belongs beside the EXE.
STATE_ROOT = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else RESOURCE_ROOT
DECODER = RESOURCE_ROOT / ".tools/vgmstream/vgmstream-cli.exe"
