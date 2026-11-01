Tab Player - portable Windows x64 edition

1. Extract the entire ZIP into a writable folder, such as Documents\TabPlayer.
2. Double-click Start Player.cmd. The player opens in your default browser.
3. Use Song folders to add your own music, or Open song to select one file.

Keep the launcher window open while playing. Press Ctrl+C or close that window
to stop the player. You can also run TabPlayer.exe directly.

Requires Windows 10/11 x64 and a recent Chromium browser (Edge or Chrome) with
WebGL 2 support. Python, Node.js, uv and an internet connection are not needed
to run the player. Windows PowerShell is used for the native folder picker.

Keep TabPlayer.exe and the entire _internal folder together. Run the player
after extracting it, rather than from inside the ZIP or from Program Files.

The library is stored in .data and decoded audio/previews in .cache next to
TabPlayer.exe. Nothing is uploaded, and original song files are not modified.
Browser preferences are stored in your browser. No songs are included.

To update, stop the player and extract the new ZIP into a separate folder.
Copy your .data and, optionally, .cache folders into that new folder to keep
your catalog and prepared audio. Saved song paths still need to exist.

Supported files: ToneLib .song and Windows Rocksmith 2014 _p.psarc with bass.
This is a proof of concept; some chart formats and techniques are unsupported.
See THIRD_PARTY.md and licenses for bundled component notices.
