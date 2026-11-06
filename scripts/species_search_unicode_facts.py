#!/usr/bin/env python3
"""Check or refresh pinned Unicode facts for Species Search normalization."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import unicodedata
from typing import Callable


REPO_ROOT = Path(__file__).resolve().parent.parent
AUTHORITY_PATH = REPO_ROOT / "canopi-types/species-search-normalization.json"
FACTS_FILENAME = "species-search-unicode-15.json"
FACTS_PATH = REPO_ROOT / "canopi-types" / FACTS_FILENAME
MAX_UNICODE_SCALAR = 0x10FFFF
HANGUL_DECOMPOSITION = {
    "s_base": 0xAC00,
    "l_base": 0x1100,
    "v_base": 0x1161,
    "t_base": 0x11A7,
    "l_count": 19,
    "v_count": 21,
    "t_count": 28,
}


def scalar_ranges(predicate: Callable[[int], bool]) -> list[list[int]]:
    ranges: list[list[int]] = []
    start: int | None = None
    previous: int | None = None
    for scalar in range(MAX_UNICODE_SCALAR + 1):
        if not predicate(scalar):
            continue
        if start is None:
            start = previous = scalar
        elif previous is not None and scalar == previous + 1:
            previous = scalar
        else:
            ranges.append([start, previous])
            start = previous = scalar
    if start is not None and previous is not None:
        ranges.append([start, previous])
    return ranges


def compile_unicode_data(version: str) -> dict[str, object]:
    if unicodedata.unidata_version != version:
        raise RuntimeError(
            "Species Search Unicode facts require Python Unicode data "
            f"{version}, found {unicodedata.unidata_version}"
        )

    def category(scalar: int) -> str:
        return unicodedata.category(chr(scalar))

    known_ranges = scalar_ranges(lambda scalar: category(scalar) not in {"Cn", "Cs"})
    mark_ranges = scalar_ranges(lambda scalar: category(scalar).startswith("M"))
    token_ranges = scalar_ranges(
        lambda scalar: category(scalar).startswith(("L", "N"))
    )
    hangul_end = (
        HANGUL_DECOMPOSITION["s_base"]
        + HANGUL_DECOMPOSITION["l_count"]
        * HANGUL_DECOMPOSITION["v_count"]
        * HANGUL_DECOMPOSITION["t_count"]
    )
    compatibility_decomposition_mappings = []
    lowercase_mappings = []
    for start, end in known_ranges:
        for scalar in range(start, end + 1):
            character = chr(scalar)
            decomposition = unicodedata.normalize("NFKD", character)
            if (
                decomposition != character
                and not HANGUL_DECOMPOSITION["s_base"] <= scalar < hangul_end
            ):
                compatibility_decomposition_mappings.append([scalar, decomposition])
            lowered = character.lower()
            if lowered != character:
                lowercase_mappings.append([scalar, lowered])

    return {
        "facts_format_version": 2,
        "unicode_data_version": version,
        "known_scalar_ranges": known_ranges,
        "mark_scalar_ranges": mark_ranges,
        "token_scalar_ranges": token_ranges,
        "hangul_decomposition": HANGUL_DECOMPOSITION,
        "compatibility_decomposition_mappings": compatibility_decomposition_mappings,
        "lowercase_mappings": lowercase_mappings,
    }


def load_authority() -> dict[str, object]:
    try:
        raw = json.loads(AUTHORITY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"failed to read {AUTHORITY_PATH}: {error}") from error
    if not isinstance(raw, dict) or not isinstance(raw.get("unicode_data"), dict):
        raise RuntimeError("Species Search authority must contain unicode_data")
    return raw


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("check", "write"))
    args = parser.parse_args()

    raw = load_authority()
    unicode_data = raw["unicode_data"]
    assert isinstance(unicode_data, dict)
    version = unicode_data.get("version")
    if not isinstance(version, str) or not version:
        raise RuntimeError("unicode_data.version must be nonempty text")
    expected = compile_unicode_data(version)
    expected_reference = {
        "version": version,
        "facts_file": FACTS_FILENAME,
    }
    if args.mode == "check":
        try:
            facts = json.loads(FACTS_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"failed to read {FACTS_PATH}: {error}") from error
        if unicode_data != expected_reference or facts != expected:
            raise RuntimeError(
                "Species Search Unicode facts are stale; run "
                "python3 scripts/species_search_unicode_facts.py write"
            )
        print(f"Species Search Unicode {version} facts OK")
        return 0

    raw["unicode_data"] = expected_reference
    AUTHORITY_PATH.write_text(
        json.dumps(raw, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    FACTS_PATH.write_text(
        json.dumps(expected, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote Species Search Unicode {version} facts to {FACTS_PATH}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error
