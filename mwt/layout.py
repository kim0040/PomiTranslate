"""World layout detection. Unsupported editions and containers are not written."""

from __future__ import annotations

from pathlib import Path

STANDARD_REGION_DIRS = (
    "region",
    "entities",
    "DIM-1/region",
    "DIM-1/entities",
    "DIM1/region",
    "DIM1/entities",
)


def _is_relative_inside(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except (OSError, RuntimeError, ValueError):
        return False
    return True


def world_data_roots(world_dir: Path) -> list[Path]:
    """Fingerprint Java worlds, not unrelated plugin/cache files in a server root."""
    root = world_dir.resolve()
    if (root / "level.dat").is_file():
        return [root]
    children = sorted(
        child for child in root.iterdir()
        if child.is_dir() and (child / "level.dat").is_file()
    )
    return children or [root]


def discover_region_dirs(world_dir: Path) -> list[str]:
    root = world_dir.resolve()
    found: list[str] = []

    def add(relative: str) -> None:
        directory = root / relative
        if directory.is_dir() and relative not in found and _is_relative_inside(root, directory):
            found.append(relative)

    for relative in STANDARD_REGION_DIRS:
        add(relative)

    dimensions = root / "dimensions"
    if _is_relative_inside(root, dimensions) and dimensions.is_dir():
        for namespace in sorted(path for path in dimensions.iterdir() if _is_relative_inside(root, path) and path.is_dir()):
            for dimension in sorted(path for path in namespace.iterdir() if _is_relative_inside(root, path) and path.is_dir()):
                for kind in ("region", "entities"):
                    add(f"dimensions/{namespace.name}/{dimension.name}/{kind}")

    for child in sorted(path for path in root.iterdir() if path.is_dir()):
        if child.name.startswith(".") or not _is_relative_inside(root, child) or not (child / "level.dat").is_file():
            continue
        for relative in STANDARD_REGION_DIRS:
            add(f"{child.name}/{relative}")
        nested = child / "dimensions"
        if _is_relative_inside(root, nested) and nested.is_dir():
            for namespace in sorted(path for path in nested.iterdir() if _is_relative_inside(root, path) and path.is_dir()):
                for dimension in sorted(path for path in namespace.iterdir() if _is_relative_inside(root, path) and path.is_dir()):
                    for kind in ("region", "entities"):
                        add(f"{child.name}/dimensions/{namespace.name}/{dimension.name}/{kind}")
    return found


def region_dir_identity(relative: str) -> tuple[str, str]:
    """``(dimension, kind)`` of a region directory given relative to the world, such as ``DIM-1/entities``.

    The dimension is ``overworld``, ``the_nether``, ``the_end`` or ``namespace:name`` for a custom one,
    prefixed ``<world>/`` inside a server root. The kind is ``entities`` or ``region``.
    """
    parts = [part for part in relative.replace("\\", "/").split("/") if part and part != "."]
    kind = "entities" if parts and parts[-1] == "entities" else "region"
    if parts and parts[-1] in {"region", "entities"}:
        parts = parts[:-1]
    prefix = ""
    if parts and parts[0] not in {"DIM-1", "DIM1", "dimensions"}:
        prefix, parts = f"{parts[0]}/", parts[1:]
    if not parts:
        dimension = "overworld"
    elif parts == ["DIM-1"]:
        dimension = "the_nether"
    elif parts == ["DIM1"]:
        dimension = "the_end"
    elif parts[0] == "dimensions" and len(parts) == 3:
        dimension = f"{parts[1]}:{parts[2]}"
    else:
        dimension = "/".join(parts)
    return f"{prefix}{dimension}", kind


def count_unsupported_region_files(world_dir: Path) -> dict[str, int]:
    """How many ``.mcr`` and ``.linear`` region files the world holds. They are detected, never read."""
    root = world_dir.resolve()
    found = {"mcr": 0, "linear": 0}
    for data_root in world_data_roots(root):
        if not _is_relative_inside(root, data_root):
            continue
        for path in data_root.rglob("*"):
            if any(part.startswith(".pomi-") for part in path.parts):
                continue
            suffix = path.suffix.lower()
            if suffix in {".mcr", ".linear"} and path.is_file():
                found[suffix[1:]] += 1
    return found


def detect_write_blockers(world_dir: Path, *, recursive: bool = True) -> list[str]:
    root = world_dir.resolve()
    reasons: list[str] = []
    database = root / "db"
    if database.is_dir() and ((database / "CURRENT").is_file() or any(database.glob("MANIFEST*"))):
        reasons.append("bedrock")
    level = root / "level.dat"
    if not _is_relative_inside(root, level):
        reasons.append("unsafe_path")
    elif level.is_file():
        with level.open("rb") as stream:
            header = stream.read(2)
        if header != b"\x1f\x8b" and database.is_dir():
            if "bedrock" not in reasons:
                reasons.append("bedrock")
    data_roots = world_data_roots(root)
    for data_root in data_roots:
        if not _is_relative_inside(root, data_root):
            if "unsafe_path" not in reasons:
                reasons.append("unsafe_path")
            continue
        for path in ([data_root / "level.dat", data_root / "resources.zip"] if not recursive else data_root.rglob("*")):
            if any(part.startswith(".pomi-") for part in path.relative_to(root).parts):
                continue
            relevant_file = path.suffix.lower() in {".dat", ".mca", ".mcc", ".mcr", ".linear"} or path.name == "resources.zip"
            relevant_directory = path.name in {"region", "entities", "dimensions", "DIM-1", "DIM1"} or "dimensions" in path.relative_to(data_root).parts
            if (relevant_file or relevant_directory) and not _is_relative_inside(root, path):
                if "unsafe_path" not in reasons:
                    reasons.append("unsafe_path")
                continue
            if path.name == "resources.zip" and path.is_symlink():
                if "unsafe_path" not in reasons:
                    reasons.append("unsafe_path")
    if not recursive:
        return reasons
    for path in (path for data_root in data_roots if _is_relative_inside(root, data_root) for path in data_root.rglob("*")):
        if not path.is_file():
            continue
        if any(part.startswith(".pomi-") for part in path.parts):
            continue
        suffix = path.suffix.lower()
        if suffix == ".mcr" and "mcr" not in reasons:
            reasons.append("mcr")
        elif suffix == ".linear" and "linear" not in reasons:
            reasons.append("linear")
    return reasons
