import io
import json
import os
import struct
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from importers import ImportFailure, rocksmith_audio
from library import ForwardReader, Library, MediaJobs, read_metadata, trim_cache
from test_importers import make_song


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.folder = self.base / 'music'
        self.folder.mkdir()
        self.source = self.folder / 'fixture.song'
        make_song(self.source)
        self.library = Library(self.base / 'catalog.sqlite3', self.base / 'media')

    def tearDown(self):
        self.library.close()
        self.temp.cleanup()

    def test_metadata_only_and_incremental_scan_survive_restart(self):
        self.library.add_root(str(self.folder))
        with patch('library.read_metadata', wraps=read_metadata) as reader:
            self.library.scan()
            self.library.scan()
            self.assertEqual(reader.call_count, 1)
        restarted = Library(self.base / 'catalog.sqlite3', self.base / 'media')
        self.assertEqual(restarted.page()['total'], 1)
        with patch('library.read_metadata', side_effect=AssertionError('Unchanged archives must not be parsed')):
            restarted.scan()
        self.assertEqual(restarted.page(query='tim fi')['total'], 1)
        self.assertEqual(list((self.base / 'media').iterdir()), [])
        song = restarted.page()['items'][0]
        self.assertEqual(song['tuning'], ['E', 'A', 'D', 'G'])
        self.assertEqual(song['duration'], 6)
        restarted.close()

    def test_overlapping_roots_do_not_duplicate_and_removal_keeps_other_root(self):
        child = self.folder / 'subfolder'
        child.mkdir()
        make_song(child / 'second.song')
        self.library.add_root(str(self.folder))
        self.library.add_root(str(child))
        with patch('library.read_metadata', wraps=read_metadata) as reader:
            self.library.scan()
            self.assertEqual(reader.call_count, 2)
        self.assertEqual(self.library.page()['total'], 2)
        root = self.library.status()['roots'][0]
        self.library.remove_root(root['id'])
        self.assertEqual(self.library.page()['total'], 1)

    def test_unavailable_root_retains_disabled_songs_and_deleted_file_disappears(self):
        self.library.add_root(str(self.folder))
        self.library.scan()
        renamed = self.folder.with_name('unplugged')
        self.folder.rename(renamed)
        self.library.scan()
        self.assertFalse(self.library.page()['items'][0]['available'])
        renamed.rename(self.folder)
        self.library.scan()
        self.assertTrue(self.library.page()['items'][0]['available'])
        self.source.unlink()
        self.library.scan()
        self.assertEqual(self.library.page()['total'], 0)

    def test_changed_file_invalidates_prepared_mapping_and_one_bad_archive_is_isolated(self):
        self.library.add_root(str(self.folder))
        self.library.scan()
        song_id = self.library.page()['items'][0]['id']
        self.library.prepared(self.library.source(song_id), 'old-cache')
        stamp = self.source.stat()
        os.utime(self.source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns + 1000000000))
        with self.assertRaisesRegex(ImportFailure, 'changed'):
            self.library.source(song_id)
        (self.folder / 'broken.psarc').write_bytes(b'bad archive')
        self.library.scan()
        self.assertIsNone(self.library.source(song_id)['prepared'])
        self.assertEqual(self.library.status()['skipped'], 1)
        self.assertEqual(self.library.page()['total'], 1)

    def test_snapshot_order_is_stable_while_new_files_are_indexed(self):
        self.library.add_root(str(self.folder))
        self.library.scan()
        first = self.library.page(limit=1)
        original_id = first['items'][0]['id']
        make_song(self.folder / 'added.song')
        self.library.scan()
        frozen = self.library.page(snapshot=first['snapshot'])
        self.assertEqual(frozen['total'], 1)
        self.assertEqual(frozen['items'][0]['id'], original_id)
        fresh = self.library.page(anchor=original_id, selected=original_id)
        self.assertEqual(fresh['total'], 2)
        self.assertGreaterEqual(fresh['anchor_index'], 0)
        self.assertEqual(fresh['anchor_index'], fresh['selected_index'])

    def test_pack_discovery_reads_manifests_only_and_selects_one_bass_per_song(self):
        class Archive:
            files = {'manifests/pack.json': 1, 'songs/bin/generic/bass.sng': 2, 'audio/windows/main.wem': 3}

            def __init__(self, path):
                pass

            def read(self, name):
                self.assert_manifest(name)
                entries = {}
                for key, represent, song in [('a-alt', 0, 'A'), ('a-main', 1, 'A'), ('b-main', 1, 'B')]:
                    entries[key] = {'Attributes': dict(ArrangementName='Bass', SongKey=song, SongName=song,
                                                       SongAsset=key, ArrangementProperties={'represent': represent})}
                return json.dumps({'Entries': entries}).encode()

            @staticmethod
            def assert_manifest(name):
                if not name.startswith('manifests/'):
                    raise AssertionError('Metadata indexing read chart or audio data')
        with patch('library.Psarc', Archive):
            result = read_metadata(Path('pack.psarc'))
        self.assertEqual([(s['title'], s['selector']) for s in result], [('A', 'a-main'), ('B', 'b-main')])

    def test_cached_play_does_not_rehash_or_reimport_and_missing_cache_is_rebuilt(self):
        self.library.add_root(str(self.folder))
        self.library.scan()
        song_id = self.library.page()['items'][0]['id']
        cache = self.base / 'songs'
        key = 'a' * 64
        target = cache / key
        target.mkdir(parents=True)
        chart = dict(id=key, audio_file='audio.wav')
        (target / 'chart.json').write_text(json.dumps(chart))
        (target / 'audio.wav').write_bytes(b'cached audio')
        self.library.prepared(self.library.source(song_id), key)
        calls = []

        def prepare(path, **kwargs):
            calls.append(path)
            (target / 'audio.wav').write_bytes(b'rebuilt audio')
            return chart

        jobs = MediaJobs(self.library, prepare, cache, self.base / 'decoder.exe')
        self.assertEqual(self.wait_job(jobs, jobs.submit('play', song_id)['job'])['result'], chart)
        self.assertEqual(calls, [])
        (target / 'audio.wav').unlink()
        self.wait_job(jobs, jobs.submit('play', song_id)['job'])
        self.assertEqual(calls, [Path(self.library.source(song_id)['path'])])

    def test_play_has_priority_and_obsolete_queued_previews_are_skipped(self):
        self.library.add_root(str(self.folder))
        self.library.scan()
        song_id = self.library.page()['items'][0]['id']
        entered, release = threading.Event(), threading.Event()
        order = []

        def preview(*args):
            order.append('preview')
            if len(order) == 1:
                entered.set()
                release.wait(3)
            return {'audio_url': '/clip.wav'}

        def prepare(*args, **kwargs):
            order.append('play')
            return {'id': 'b' * 64}

        with patch('library.make_preview', preview):
            jobs = MediaJobs(self.library, prepare, self.base / 'songs', self.base / 'decoder.exe')
            first = jobs.submit('preview', song_id, 'client', 1)['job']
            self.assertTrue(entered.wait(3))
            obsolete = jobs.submit('preview', song_id, 'client', 2)['job']
            latest = jobs.submit('preview', song_id, 'client', 3)['job']
            play = jobs.submit('play', song_id)['job']
            release.set()
            for job in (first, obsolete, latest, play):
                self.wait_job(jobs, job)
        self.assertEqual(order, ['preview', 'play', 'preview'])
        self.assertEqual(jobs.get(obsolete)['state'], 'cancelled')

    def test_cache_budget_evicts_old_generated_audio_but_keeps_recent_assets(self):
        old = self.base / 'media' / 'old.wav'
        recent = old.with_name('recent.wav')
        untouched = old.with_name('original.song')
        for file in (old, recent, untouched):
            file.write_bytes(b'0123456789')
        os.utime(old, (time.time() - 1000, time.time() - 1000))
        trim_cache(old.parent, '*.wav', 10)
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())
        self.assertTrue(untouched.exists())

    def wait_job(self, jobs, key):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            job = jobs.get(key)
            if job['state'] in ('ready', 'error', 'cancelled'):
                self.assertNotEqual(job['state'], 'error', job.get('error'))
                return job
            time.sleep(.01)
        self.fail('Media job did not finish')


class PipeTests(unittest.TestCase):
    def test_wave_can_parse_a_pipe_without_system_seeking(self):
        data = io.BytesIO()
        with wave.open(data, 'wb') as output:
            output.setparams((2, 2, 48000, 0, 'NONE', 'not compressed'))
            output.writeframes(b'\0' * 48000 * 4)

        class Pipe:
            def read(self, size=-1):
                return source.read(size)
        source = io.BytesIO(data.getvalue())
        with wave.open(ForwardReader(Pipe()), 'rb') as clip:
            self.assertEqual(clip.getframerate(), 48000)
            self.assertEqual(len(clip.readframes(24000)), 96000)

    def test_pack_audio_follows_the_selected_song_and_its_preview_bank(self):
        class Archive:
            files = dict.fromkeys(['audio/a.bnk', 'audio/a_preview.bnk', 'audio/b.bnk',
                                  'audio/100.wem', 'audio/101.wem', 'audio/200.wem'])

            def read(self, name):
                audio_id = {'audio/a.bnk': 100, 'audio/a_preview.bnk': 101, 'audio/b.bnk': 200}[name]
                return b'DIDX' + struct.pack('<IIII', 12, audio_id, 0, 1)
        archive = Archive()
        self.assertEqual(rocksmith_audio(archive, {'SongBank': 'b.bnk'}), 'audio/200.wem')
        self.assertEqual(rocksmith_audio(archive, {'PreviewBankPath': 'a_preview.bnk'}, preview=True), 'audio/101.wem')
