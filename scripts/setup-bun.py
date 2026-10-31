"""Install the pinned official Bun Windows binary inside this project only."""

import hashlib
import json
import platform
import sys
import urllib.request
import uuid
import zipfile
from pathlib import Path


def main():
    if sys.platform != "win32" or platform.machine().lower() not in ("amd64", "x86_64"):
        raise RuntimeError("This installer supports Windows x64. The operating app keeps its existing runtime.")
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "scripts/bun-release.json").read_text(encoding="utf8"))
    tool_root = (root / ".t3/tools/bun").resolve()
    if not tool_root.is_relative_to(root):
        raise RuntimeError("Bun destination must stay inside this workspace")
    destination = tool_root / manifest["version"] / "bun.exe"
    if destination.exists():
        if destination.is_symlink() or hashlib.sha256(destination.read_bytes()).hexdigest() != manifest["binarySha256"]:
            raise RuntimeError("Existing Bun binary does not match the pinned release; it was not overwritten")
        print(json.dumps({"version": manifest["version"], "path": str(destination), "verified": True}))
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    nonce = uuid.uuid4().hex
    archive = tool_root / (nonce + ".zip")
    partial = destination.parent / (nonce + ".part")
    try:
        digest = hashlib.sha256()
        total = 0
        request = urllib.request.Request(manifest["url"], headers={"User-Agent": "T3-pinned-Bun-setup"})
        with urllib.request.urlopen(request, timeout=30) as response, archive.open("xb") as output:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > manifest["archiveBytes"]:
                    raise RuntimeError("Bun download exceeded its expected size")
                digest.update(chunk)
                output.write(chunk)
        if total != manifest["archiveBytes"] or digest.hexdigest() != manifest["archiveSha256"]:
            raise RuntimeError("Official Bun archive checksum did not match")
        with zipfile.ZipFile(archive) as bundle:
            entry = bundle.getinfo(manifest["entry"])
            if entry.file_size != manifest["binaryBytes"]:
                raise RuntimeError("Unexpected Bun executable size")
            digest = hashlib.sha256()
            total = 0
            with bundle.open(entry) as source, partial.open("xb") as output:
                while chunk := source.read(1024 * 1024):
                    total += len(chunk)
                    if total > manifest["binaryBytes"]:
                        raise RuntimeError("Bun executable exceeded its expected size")
                    digest.update(chunk)
                    output.write(chunk)
            if total != manifest["binaryBytes"] or digest.hexdigest() != manifest["binarySha256"]:
                raise RuntimeError("Bun executable checksum did not match")
        if destination.exists():
            raise RuntimeError("Bun destination appeared during installation; no existing file was replaced")
        partial.rename(destination)
        print(json.dumps({"version": manifest["version"], "path": str(destination), "verified": True}))
    finally:
        archive.unlink(missing_ok=True)
        partial.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
