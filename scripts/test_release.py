"""Regression checks for release guards and distributable UI completeness."""

import io
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

from release import check_source, check_tree, validate_ref


class ReleaseGuardTests(unittest.TestCase):
    def test_packaging_accepts_generated_assets_but_requires_clean_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            def git(*args):
                subprocess.run(
                    ["git", "-C", str(root), *args], check=True, capture_output=True
                )

            git("init")
            (root / ".gitignore").write_text("/web/dist/\n")
            (root / "source.rs").write_text("source")
            git("add", ".")
            git(
                "-c",
                "user.name=Release test",
                "-c",
                "user.email=release@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "test: create fixture",
            )
            assets = root / "web/dist"
            assets.mkdir(parents=True)
            (assets / "index.html").write_text("generated")
            check_tree(root)
            (root / "source.rs").write_text("changed")
            with self.assertRaisesRegex(ValueError, "Commit source changes"):
                check_tree(root)
            git("add", "source.rs")
            with self.assertRaisesRegex(ValueError, "Commit source changes"):
                check_tree(root)

    def test_matching_tag_can_publish(self):
        for event in ["push", "workflow_dispatch"]:
            validate_ref(
                "0.1.0",
                {
                    "GITHUB_EVENT_NAME": event,
                    "GITHUB_REF_TYPE": "tag",
                    "GITHUB_REF_NAME": "v0.1.0",
                    "DRY_RUN": "false",
                },
            )

    def test_branch_can_only_rehearse(self):
        env = {
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF_TYPE": "branch",
            "GITHUB_REF_NAME": "main",
            "DRY_RUN": "true",
        }
        validate_ref("0.1.0", env)
        for dry_run in ["false", ""]:
            with self.assertRaisesRegex(ValueError, "existing version tag"):
                validate_ref("0.1.0", dict(env, DRY_RUN=dry_run))

    def test_mismatched_tag_cannot_publish(self):
        with self.assertRaisesRegex(ValueError, "Tag must match"):
            validate_ref(
                "0.1.0",
                {
                    "GITHUB_EVENT_NAME": "push",
                    "GITHUB_REF_TYPE": "tag",
                    "GITHUB_REF_NAME": "v0.2.0",
                },
            )

    def test_pull_request_cannot_publish(self):
        with self.assertRaisesRegex(ValueError, "Unsupported release event"):
            validate_ref("0.1.0", {"GITHUB_EVENT_NAME": "pull_request"})


class SourcePackageTests(unittest.TestCase):
    def package(self, files):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "rdfscope-0.1.0.crate"
        with tarfile.open(path, "w:gz") as archive:
            for name, contents in files.items():
                data = contents.encode()
                info = tarfile.TarInfo("rdfscope-0.1.0/" + name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        return path

    def files(self):
        files = dict.fromkeys(
            [
                "Cargo.lock",
                "src/main.rs",
                "src/lib.rs",
                "src/dataset.rs",
                "src/exploration.rs",
                "build.rs",
                "LICENSE",
                "README.md",
                "pyproject.toml",
                "examples/research-library.trig",
                "web/dist/THIRD_PARTY_LICENSES.txt",
            ],
            "",
        )
        files.update(
            {
                "Cargo.toml": '[package]\nversion = "0.1.0"',
                "web/dist/index.html": '<script src="/assets/app.js"></script>',
                "web/dist/assets/app.js": "console.log('RDFscope')",
            }
        )
        return files

    def test_complete_embedded_ui(self):
        check_source(self.package(self.files()), "0.1.0")

    def test_missing_compiled_asset_fails(self):
        files = self.files()
        del files["web/dist/assets/app.js"]
        with self.assertRaisesRegex(ValueError, "Missing UI asset"):
            check_source(self.package(files), "0.1.0")

    def test_missing_notices_fails(self):
        files = self.files()
        del files["web/dist/THIRD_PARTY_LICENSES.txt"]
        with self.assertRaisesRegex(ValueError, "Source package missing"):
            check_source(self.package(files), "0.1.0")

    def test_missing_shared_engine_fails(self):
        for name in ["src/lib.rs", "src/dataset.rs", "src/exploration.rs"]:
            with self.subTest(name=name):
                files = self.files()
                del files[name]
                with self.assertRaisesRegex(ValueError, "Source package missing"):
                    check_source(self.package(files), "0.1.0")

    def test_browser_artifacts_are_excluded_from_native_packages(self):
        for name in [
            "browser/src/lib.rs",
            "web/wasm/rdfscope_browser_bg.wasm",
            "web/dist-browser/index.html",
        ]:
            with (
                self.subTest(name=name),
                self.assertRaisesRegex(ValueError, "Browser build files packaged"),
            ):
                check_source(
                    self.package(dict(self.files(), **{name: "browser"})), "0.1.0"
                )

    def test_private_workspaces_and_designs_are_rejected(self):
        for name in [
            "DESIGN.md",
            ".impeccable/review/desktop.png",
            "session.rdfscope.json",
        ]:
            with (
                self.subTest(name=name),
                self.assertRaisesRegex(ValueError, "[Ww]orking file"),
            ):
                check_source(
                    self.package(dict(self.files(), **{name: "private"})), "0.1.0"
                )


if __name__ == "__main__":
    unittest.main()
