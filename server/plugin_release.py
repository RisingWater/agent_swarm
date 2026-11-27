"""从实际分发包生成各适配器的版本，重新打包同一份源码不触发更新。"""
from functools import lru_cache
from hashlib import file_digest, sha256
from pathlib import Path, PurePosixPath
import tarfile

ADAPTERS = ("opencode", "claude", "deepseek", "codex")


def archive_manifest(path: Path) -> dict:
    stat = path.stat()
    return _manifest(path, stat.st_dev, stat.st_ino, stat.st_mtime_ns, stat.st_size)


@lru_cache(maxsize=4)
def _manifest(path: Path, device: int, inode: int, mtime: int, size: int) -> dict:
    with path.open("rb") as package:
        package_digest = file_digest(package, "sha256").hexdigest()
        package.seek(0)
        files: dict[str, dict[str, str]] = {name: {} for name in ADAPTERS}
        with tarfile.open(fileobj=package, mode="r:gz") as archive:
            for member in archive:
                parts = PurePosixPath(member.name).parts
                if not member.isfile() or len(parts) < 3 or parts[0] != "plugins" or parts[1] not in files:
                    continue
                with archive.extractfile(member) as stream:
                    files[parts[1]]["/".join(parts[2:])] = file_digest(stream, "sha256").hexdigest()
        if "nexus_a2a.mjs" in files["claude"] and files["codex"]:
            files["codex"]["../claude/nexus_a2a.mjs"] = files["claude"]["nexus_a2a.mjs"]
        return {
            "sha256": package_digest,
            "plugins": {
                name: sha256("".join(f"{p}\0{digest}\n" for p, digest in sorted(entries.items())).encode()).hexdigest()
                for name, entries in files.items() if entries
            },
        }
