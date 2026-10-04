"""Find the Java worlds a launcher keeps, so the app can list them the way the game does.

Read-only: it opens ``level.dat`` and ``icon.png`` and nothing else, and never follows a world
outside the saves folder it was found in.
"""

from __future__ import annotations

import base64
import gzip
import os
import sys
from pathlib import Path
from typing import Any

MAX_WORLDS = 60
MAX_ICON_BYTES = 64 * 1024  # A game icon is 64x64; larger files are not icons the game made.


def saves_dirs(home: Path | None = None, *, platform: str | None = None, env: dict[str, str] | None = None) -> list[Path]:
    """Saves folders of the official launcher and the common third-party launchers."""
    home = home or Path.home()
    platform = platform or sys.platform
    env = os.environ if env is None else env
    if platform == "darwin":
        support = home / "Library" / "Application Support"
        roots = [support / "minecraft"]
        launchers = [support / "PrismLauncher", support / "MultiMC"]
    elif platform.startswith("win"):
        appdata = Path(env.get("APPDATA") or home / "AppData" / "Roaming")
        roots = [appdata / ".minecraft"]
        launchers = [appdata / "PrismLauncher", home / "curseforge" / "minecraft"]
    else:
        roots = [home / ".minecraft"]
        launchers = [home / ".local" / "share" / "PrismLauncher", home / ".var" / "app" / "org.prismlauncher.PrismLauncher" / "data" / "PrismLauncher"]
    found = [root / "saves" for root in roots]
    for launcher in launchers:
        for instances in (launcher / "instances", launcher / "Instances"):
            try:
                children = sorted(instances.iterdir()) if instances.is_dir() else []
            except OSError:
                continue
            for instance in children:
                for game in (instance / ".minecraft", instance / "minecraft", instance):
                    if (game / "saves").is_dir():
                        found.append(game / "saves")
                        break
    # On case-insensitive file systems (the macOS and Windows defaults) "instances" and "Instances"
    # are one folder, so compare what the paths point at rather than how they are spelled.
    unique: list[Path] = []
    for item in found:
        if item.is_dir() and not any(_same_dir(item, kept) for kept in unique):
            unique.append(item)
    return unique


def _same_dir(left: Path, right: Path) -> bool:
    try:
        return os.path.samefile(left, right)
    except OSError:
        return left == right


def _level_summary(level_dat: Path) -> dict[str, Any]:
    from mwt import nbtio

    try:
        document = nbtio.parse(gzip.decompress(level_dat.read_bytes()), keep_scalars="all")
    except (OSError, ValueError, TypeError, EOFError):
        return {}
    data = document.get("Data")
    node = data if isinstance(data, dict) else document
    summary: dict[str, Any] = {}
    name = node.get("LevelName")
    if name is not None and isinstance(getattr(name, "value", None), str):
        summary["levelName"] = name.value
    played = node.get("LastPlayed")
    if played is not None and isinstance(getattr(played, "value", None), int):
        summary["lastPlayed"] = int(played.value) // 1000  # level.dat keeps milliseconds; the app uses seconds.
    version = node.get("DataVersion")
    if version is not None and isinstance(getattr(version, "value", None), int):
        summary["dataVersion"] = int(version.value)
    game = node.get("Version")
    if isinstance(game, dict) and isinstance(getattr(game.get("Name"), "value", None), str):
        summary["versionName"] = game["Name"].value
    return summary


def _icon(world: Path) -> str | None:
    icon = world / "icon.png"
    try:
        if icon.is_symlink() or not icon.is_file() or icon.stat().st_size > MAX_ICON_BYTES:
            return None
        raw = icon.read_bytes()
    except OSError:
        return None
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return None
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


def discover_worlds(dirs: list[Path] | None = None) -> dict[str, Any]:
    roots = saves_dirs() if dirs is None else dirs
    worlds: list[dict[str, Any]] = []
    for root in roots:
        try:
            children = list(root.iterdir())
        except OSError:
            continue
        for world in children:
            try:
                if world.is_symlink() or not world.is_dir() or not (world / "level.dat").is_file():
                    continue
                if not world.resolve().is_relative_to(root.resolve()):
                    continue
                modified = int(world.stat().st_mtime)
            except OSError:
                continue
            summary = _level_summary(world / "level.dat")
            worlds.append(
                {
                    "path": str(world),
                    "folder": world.name,
                    "name": summary.get("levelName") or world.name,
                    "lastPlayed": summary.get("lastPlayed") or modified,
                    "dataVersion": summary.get("dataVersion"),
                    "versionName": summary.get("versionName"),
                    "icon": _icon(world),
                    "source": str(root),
                }
            )
    worlds.sort(key=lambda item: item["lastPlayed"] or 0, reverse=True)
    return {"worlds": worlds[:MAX_WORLDS], "savesDirs": [str(item) for item in roots], "total": len(worlds)}
