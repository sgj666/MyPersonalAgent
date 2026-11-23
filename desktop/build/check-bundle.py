#!/usr/bin/env python3
"""Fail the release when the frozen backend cannot download videos.

The installers ship a PyInstaller onedir bundle, and "install it and everything
is ready" depends on two things being inside it:

- ``yt_dlp`` with its extractors — they are imported from a generated list, so a
  bundle built without ``collect_submodules('yt_dlp')`` answers "Unsupported
  URL" for every platform.
- ``imageio_ffmpeg``'s static ffmpeg binary — Bilibili serves video and audio
  separately, so without it every B 站 download fails at the merge step with
  "缺少 ffmpeg，B 站这类音视频分开的视频无法合并".

Both are easy to lose silently: the app still starts, the page still renders,
and the failure only shows up on a user's machine when they paste a link.

Python modules live inside the PYZ archive (not as files on disk), so the check
reads PyInstaller's own TOC. Data files, like the ffmpeg binary, are checked on
disk as well.

Usage:
    python desktop/build/check-bundle.py --dist desktop/build/dist/cowagent-backend \
        [--work desktop/build/build-work]
"""

from __future__ import annotations

import argparse
import ast
import glob
import os

MIN_FFMPEG_BYTES = 10 * 1024 * 1024
REQUIRED_MODULE = "yt_dlp.extractor.bilibili"


def _toc_modules(work: str) -> list[str]:
    """Every module/file name PyInstaller recorded for this bundle."""
    names: list[str] = []
    for path in glob.glob(os.path.join(work, "*", "*.toc")):
        try:
            data = ast.literal_eval(open(path, encoding="utf-8").read())
        except (OSError, ValueError, SyntaxError):
            continue
        for group in data if isinstance(data, tuple) else ():
            if not isinstance(group, (list, tuple)):
                continue
            for entry in group:
                if isinstance(entry, tuple) and entry and isinstance(entry[0], str):
                    names.append(entry[0])
    return names


def _ffmpeg_binary(root: str) -> str:
    for base, _dirs, files in os.walk(root):
        if "imageio_ffmpeg" not in base.replace(os.sep, "/"):
            continue
        for name in files:
            if name.startswith("ffmpeg"):
                path = os.path.join(base, name)
                if os.path.getsize(path) >= MIN_FFMPEG_BYTES:
                    return path
    return ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", required=True, help="the onedir bundle")
    parser.add_argument("--work", default="", help="PyInstaller work dir (auto-detected)")
    args = parser.parse_args()

    if not os.path.isdir(args.dist):
        print(f"FAIL bundle not found: {args.dist}")
        return 2

    work = args.work
    if not work:
        # build-backend.sh and the release workflow both put the work dir next to
        # dist: <build>/dist/cowagent-backend + <build>/build-work/cowagent-backend.
        guess = os.path.join(os.path.dirname(os.path.dirname(args.dist)), "build-work")
        work = guess if os.path.isdir(guess) else ""

    problems = []
    modules = _toc_modules(work) if work else []
    if not modules:
        problems.append(f"no PyInstaller TOC found under {work or '(none)'} — "
                        "pass --work so the bundled modules can be checked")
    elif not any(name == REQUIRED_MODULE or name.startswith(REQUIRED_MODULE + ".") for name in modules):
        problems.append("yt_dlp extractors are missing (collect_submodules('yt_dlp'))")

    ffmpeg = _ffmpeg_binary(args.dist)
    if not ffmpeg:
        problems.append("imageio_ffmpeg's ffmpeg binary is missing or truncated "
                        "(collect_data_files('imageio_ffmpeg'))")

    if problems:
        print("FAIL the bundle cannot download videos:")
        for item in problems:
            print(f"  - {item}")
        return 1

    print("OK bundle contains the video engine:")
    print(f"  yt-dlp modules: {sum(1 for n in modules if n.startswith('yt_dlp'))}")
    print(f"  ffmpeg:         {ffmpeg} ({os.path.getsize(ffmpeg) // (1024 * 1024)} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
