import tempfile
import unittest
import wave
import zipfile
from io import BytesIO
from pathlib import Path

from importers import ImportFailure, full_difficulty_notes, read_tonelib
from server import byte_range


def make_song(path, *, extra="", tied_fret=0):
    # One second of silence is enough to exercise the actual archive/audio path.
    backing = BytesIO()
    with wave.open(backing, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(8000)
        wav.writeframes(bytes(16000))
    score = f"""<Score><info><name>Timing fixture</name></info>
      <BarIndex><Bar id="1" tempo="120"><time_sign numerator="4" duration="4"/></Bar>
      <Bar id="2" tempo="60"/></BarIndex>
      <Tracks><Track name="Bass"><Strings>
      <String id="1" tuning="43"/><String id="2" tuning="38"/>
      <String id="3" tuning="33"/><String id="4" tuning="28"/>
      </Strings><Bars><Bar id="1">
      <Beat duration="2"><Note fret="5" string="4"/></Beat>
      <Beat duration="2"><Note fret="{tied_fret}" string="4" tied="yes"/></Beat>
      {extra}</Bar><Bar id="2"><Beat duration="4"><Note fret="7" string="1"/></Beat>
      <Beat duration="2"/><Beat duration="4"/></Bar></Bars></Track></Tracks>
      <Backing_track1><audio><data_file>audio/test.snd</data_file></audio></Backing_track1></Score>"""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("the_song.dat", score.encode() + b"\0")
        archive.writestr("audio/test.snd", backing.getvalue())


class ToneLibTests(unittest.TestCase):
    def test_tempo_change_tie_and_string_order(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            source = folder / "input.song"
            make_song(source)
            chart = read_tonelib(source, folder)
            self.assertEqual(chart["strings"], ["E", "A", "D", "G"])
            self.assertEqual(chart["notes"], [
                {"time": 0.0, "end": 2.0, "string": 0, "fret": 5},
                {"time": 2.0, "end": 3.0, "string": 3, "fret": 7},
            ])
            self.assertEqual(chart["duration"], 6)
            self.assertEqual([b["time"] for b in chart["beats"]], [0, .5, 1, 1.5, 2, 3, 4, 5])
            self.assertTrue((folder / "audio.wav").read_bytes().startswith(b"RIFF"))

    def test_broken_tie_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "input.song"
            make_song(source, tied_fret=9)
            with self.assertRaisesRegex(ImportFailure, "tie changes"):
                read_tonelib(source, Path(folder))

    def test_unsupported_second_voice_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "input.song"
            make_song(source, extra='<Beats><Beat duration="1"/></Beats>')
            with self.assertRaisesRegex(ImportFailure, "second voice"):
                read_tonelib(source, Path(folder))


class RocksmithDifficultyTests(unittest.TestCase):
    def test_each_phrase_uses_its_authored_maximum_without_lower_level_notes(self):
        easy = {"time": 1.0, "end": 1.2, "string": 0, "fret": 0}
        first_full = {"time": 1.0, "end": 1.2, "string": 0, "fret": 5}
        second_easy = {"time": 11.0, "end": 11.2, "string": 0, "fret": 1}
        second_full = {"time": 11.0, "end": 11.2, "string": 0, "fret": 7}
        boundary = {"time": 10.0, "end": 10.5, "string": 1, "fret": 3}
        result = full_difficulty_notes({0: [easy], 1: [first_full, second_easy], 3: [boundary, second_full]},
                                       [(0, 10, 1), (10, 20, 3)])
        self.assertEqual(result, [first_full, boundary, second_full])


class RangeTests(unittest.TestCase):
    def test_seek_and_suffix_ranges(self):
        self.assertEqual(byte_range("bytes=100-199", 1000), (100, 199, True))
        self.assertEqual(byte_range("bytes=900-", 1000), (900, 999, True))
        self.assertEqual(byte_range("bytes=-100", 1000), (900, 999, True))
        self.assertEqual(byte_range(None, 1000), (0, 999, False))

    def test_invalid_ranges(self):
        for value in ("bytes=1000-", "bytes=5-1", "bytes=-0", "bytes=1-2,4-5", "garbage"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                byte_range(value, 1000)


if __name__ == "__main__":
    unittest.main()
