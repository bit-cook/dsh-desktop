"""Publish archives without losing history or overwriting an existing version.

All callers must hold the desktop-version-catalog Actions concurrency group.
The direct ModelScope index is authoritative; read errors never bootstrap it.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

SEMVER = re.compile(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\Z")


def read_remote(url):
    request = Request(f"{url}?catalog_read={time.time_ns()}", headers={"Cache-Control": "no-cache"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=30) as response:
                return response.read()
        except HTTPError as error:
            if error.code == 404:
                raise
            if attempt == 2:
                raise
        except OSError:
            if attempt == 2:
                raise
        time.sleep(attempt + 1)


def publish(api, repo_id, token, tag, assets, stable_history="keep", publish_latest=False, read=read_remote):
    version = tag.removeprefix("v")
    if not SEMVER.fullmatch(version):
        raise ValueError("Expected a release tag containing a semantic version")
    base = f"https://modelscope.cn/models/{repo_id}/resolve/master/releases"
    # Fail before ANY write on unavailable, missing, or corrupt historical state.
    current = json.loads(read(f"{base}/versions.json"))
    assets = Path(assets)
    with tempfile.TemporaryDirectory() as work:
        current_file = Path(work) / "current.json"
        index_file = Path(work) / "versions.json"
        current_file.write_text(json.dumps(current))
        subprocess.run([
            "node", "scripts/build-version-index.mjs", str(current_file),
            str(index_file), version, stable_history,
        ], check=True)

        # An already published version is immutable, including on workflow reruns.
        # Check both platform feeds: a half-written archive is never indexed.
        existing = []
        for name in ("latest.yml", "latest-mac.yml"):
            try:
                remote = read(f"{base}/archive/{version}/{name}")
            except HTTPError as error:
                if error.code != 404:
                    raise
                existing.append(False)
            else:
                existing.append(True)
                if remote != (assets / name).read_bytes():
                    raise ValueError(f"Archive {version}/{name} already exists with different content; use a new version")
        if any(existing) and not all(existing):
            raise ValueError(f"Archive {version} is incomplete; refusing to replace or publish it")
        if not any(existing):
            api.upload_folder(repo_id=repo_id, folder_path=str(assets),
                              path_in_repo=f"releases/archive/{version}",
                              commit_message=f"Archive {tag}", token=token)
        # Only publish the index once the archive has been uploaded successfully.
        api.upload_file(path_or_fileobj=str(index_file), path_in_repo="releases/versions.json",
                        repo_id=repo_id, commit_message=f"Version index for {tag} ({stable_history})", token=token)
        if publish_latest:
            api.upload_folder(repo_id=repo_id, folder_path=str(assets), path_in_repo="releases/latest",
                              commit_message=f"Release {tag}", token=token)
    print(f"Published {tag}; stable history: {stable_history}; latest: {publish_latest}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--assets", default="release-assets")
    parser.add_argument("--stable-history", choices=("keep", "retain", "unpin"), default="keep")
    parser.add_argument("--publish-latest", action="store_true")
    args = parser.parse_args()
    from modelscope.hub.api import HubApi
    publish(HubApi(), os.environ["MODELSCOPE_REPO_ID"], os.environ["MODELSCOPE_TOKEN"],
            args.tag, args.assets, args.stable_history, args.publish_latest)
