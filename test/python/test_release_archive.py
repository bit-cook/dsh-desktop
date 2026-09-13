import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location("publisher", ".github/scripts/publish_release_archive.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class Publication(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.assets = Path(self.temp.name)
        for name in ("latest.yml", "latest-mac.yml"):
            (self.assets / name).write_bytes(b"version: 2.0.0\n")
        self.api = Mock()
        self.current = {"versions": [{"version": "1.0.0", "stableHistory": True}]}
        self.files = {"versions.json": json.dumps(self.current).encode()}
        self.published = []
        self.api.upload_file.side_effect = lambda **kw: self.published.append(json.loads(Path(kw['path_or_fileobj']).read_text()))

    def read(self, url):
        key = url.split('/releases/')[1]
        if key not in self.files:
            raise HTTPError(url, 404, 'missing', {}, None)
        return self.files[key]

    def publish(self, **kwargs):
        publisher.publish(self.api, 'fixture/repo', 'unused', 'v2.0.0', self.assets, read=self.read, **kwargs)

    def test_retains_selected_history_and_adds_current(self):
        self.publish(publish_latest=True)
        self.assertEqual([v['version'] for v in self.published[0]['versions']], ['2.0.0', '1.0.0'])
        self.assertTrue(self.published[0]['versions'][1]['stableHistory'])
        self.assertEqual([c.kwargs.get('path_in_repo') for c in self.api.mock_calls],
                         ['releases/archive/2.0.0', 'releases/versions.json', 'releases/latest'])

    def test_explicit_selection_survives_next_release_and_can_be_unpinned(self):
        self.publish(stable_history='retain')
        retained = self.published[-1]
        self.files['versions.json'] = json.dumps(retained).encode()
        self.publish()
        self.assertTrue(self.published[-1]['versions'][0]['stableHistory'])
        self.publish(stable_history='unpin')
        self.assertNotIn('stableHistory', self.published[-1]['versions'][0])
        self.assertTrue(self.published[-1]['versions'][1]['stableHistory'])

    def test_missing_corrupt_and_unavailable_index_never_write(self):
        for value in (None, b'not json', b'{}', b'{"versions":[{"version":"bad"}]}'):
            with self.subTest(value=value):
                self.files = {} if value is None else {'versions.json': value}
                with self.assertRaises(Exception):
                    self.publish(publish_latest=True)
                self.assertEqual(self.api.mock_calls, [])
        with self.assertRaises(OSError):
            publisher.publish(self.api, 'fixture/repo', 'unused', 'v2.0.0', self.assets,
                              read=Mock(side_effect=OSError('offline')))
        self.assertEqual(self.api.mock_calls, [])

    def test_existing_archive_is_not_uploaded_again(self):
        for name in ('latest.yml', 'latest-mac.yml'):
            self.files[f'archive/2.0.0/{name}'] = (self.assets / name).read_bytes()
        self.publish(stable_history='retain')
        self.api.upload_folder.assert_not_called()
        self.assertTrue(self.published[0]['versions'][0]['stableHistory'])

    def test_replaced_or_partial_archive_never_writes(self):
        for content in (b'version: 9.0.0', b'version: 2.0.0\n'):
            self.files['archive/2.0.0/latest.yml'] = content
            with self.assertRaises(ValueError):
                self.publish()
            self.assertEqual(self.api.mock_calls, [])

    def test_failed_archive_upload_never_publishes_index_or_latest(self):
        self.api.upload_folder.side_effect = OSError('upload failed')
        with self.assertRaises(OSError):
            self.publish(publish_latest=True)
        self.api.upload_file.assert_not_called()
        self.assertEqual(self.api.upload_folder.call_count, 1)
