import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from waymark_browser import app


class SetupTests(unittest.TestCase):
    def test_unrelated_directory_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            sentinel = Path(temp) / "notes.txt"
            sentinel.write_text("keep me", encoding="utf-8")
            with patch.object(app, "download") as download:
                with self.assertRaisesRegex(SystemExit, "Refusing to replace"):
                    app.setup(temp, None, skip_install=True)
                download.assert_not_called()
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep me")

    def test_source_checkout_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            (target / "package.json").write_text(json.dumps({"name": "waymark-browser"}))
            (target / ".git").mkdir()
            with patch.object(app, "download") as download:
                with self.assertRaisesRegex(SystemExit, "Refusing to replace"):
                    app.setup(temp, None, skip_install=True)
                download.assert_not_called()

    def test_install_and_upgrade_preserve_user_data(self):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:gz") as tar:
            data = json.dumps({"name": "waymark-browser"}).encode()
            member = tarfile.TarInfo("release/package.json")
            member.size = len(data)
            tar.addfile(member, io.BytesIO(data))
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "app"
            with patch.object(app, "download", return_value=archive.getvalue()):
                app.setup(str(target), "v0.2.0", skip_install=True)
                (target / "data").mkdir()
                sentinel = target / "data" / "profile.txt"
                sentinel.write_text("keep profile", encoding="utf-8")
                app.setup(str(target), "v0.2.0", skip_install=True)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep profile")
