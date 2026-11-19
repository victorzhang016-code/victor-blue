"""Build the three portable Victor Blue downloads with official Node binaries."""
import argparse
import hashlib
import io
from pathlib import Path
import tarfile
from urllib.request import urlopen
import zipfile

NODE_VERSION = "v24.22.3"
NODE_BASE = f"https://nodejs.org/dist/{NODE_VERSION}"
ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
PLATFORMS = {
    "windows-x64": ("win-x64.zip", "Start Victor Blue.cmd", "node.exe"),
    "macos-arm64": ("darwin-arm64.tar.gz", "Start Victor Blue.command", "bin/node"),
    "macos-x64": ("darwin-x64.tar.gz", "Start Victor Blue.command", "bin/node"),
}

def obtain(cache, name):
    path = cache / name
    if not path.exists():
        with urlopen(f"{NODE_BASE}/{name}", timeout=90) as response:
            data = response.read()
        path.write_bytes(data)
    return path

def node_files(archive, prefix, runtime):
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as source:
            return [source.read(f"{prefix}/{name}") for name in (runtime, "LICENSE")]
    with tarfile.open(archive, "r:gz") as source:
        files = []
        for name in (runtime, "LICENSE"):
            entry = source.getmember(f"{prefix}/{name}")
            assert entry.isfile()
            with source.extractfile(entry) as stream:
                files.append(stream.read())
        return files

def package(cache):
    checksums = {}
    for line in obtain(cache, "SHASUMS256.txt").read_text(encoding="utf-8").splitlines():
        checksum, name = line.split()
        checksums[name] = checksum
    DIST.mkdir(exist_ok=True)
    manifest = []
    for platform, (suffix, launcher, runtime) in PLATFORMS.items():
        prefix = "node-" + NODE_VERSION + "-" + suffix.split(".")[0]
        name = "node-" + NODE_VERSION + "-" + suffix
        original = obtain(cache, name)
        with original.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != checksums[name]:
                raise ValueError(f"Node.js checksum mismatch: {name}")
        binary, license_text = node_files(original, prefix, runtime)
        common = ["README.md", "LICENSE", launcher, "scripts/launcher.mjs",
                  "theme/victor-blue.css", "theme/macos.css", "docs/preview.png"]
        files = {relative: (ROOT / relative).read_bytes() for relative in common}
        entry = "runtime/" + Path(runtime).name
        files[entry] = binary
        files["runtime/LICENSE"] = license_text
        if platform.startswith("windows"):
            target = DIST / f"Victor-Blue-{platform}.zip"
            with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as release:
                for relative, blob in files.items():
                    release.writestr("Victor Blue/" + relative, blob)
        else:
            target = DIST / f"Victor-Blue-{platform}.tar.gz"
            with tarfile.open(target, "w:gz", compresslevel=6) as release:
                for relative, blob in files.items():
                    member = tarfile.TarInfo("Victor Blue/" + relative)
                    member.size = len(blob)
                    member.mode = 0o755 if relative in (launcher, entry) else 0o644
                    release.addfile(member, io.BytesIO(blob))
        with target.open("rb") as stream:
            manifest.append(hashlib.file_digest(stream, "sha256").hexdigest() + "  " + target.name)
        print(target.name)
    (DIST / "SHA256SUMS.txt").write_text("\n".join(manifest)+"\n", encoding="utf-8")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--node-cache", type=Path, default=DIST/"node-cache")
    cache = parser.parse_args().node_cache
    cache.mkdir(parents=True, exist_ok=True)
    package(cache)
