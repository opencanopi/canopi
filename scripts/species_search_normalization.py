"""Versioned Species Search normalization shared by catalog builders."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from bisect import bisect_right
import hashlib
import json
from pathlib import Path
from typing import Any


AUTHORITY_PATH = (
    Path(__file__).resolve().parent.parent
    / "canopi-types/species-search-normalization.json"
)


class SpeciesSearchAdmission(str, Enum):
    BROWSE = "browse"
    TOO_SHORT = "too-short"
    ACTIVE_TEXT = "active-text"


@dataclass(frozen=True)
class HangulDecomposition:
    s_base: int
    l_base: int
    v_base: int
    t_base: int
    l_count: int
    v_count: int
    t_count: int


@dataclass(frozen=True)
class SpeciesSearchNormalizationContract:
    version: int
    fingerprint: str
    unicode_data_version: str
    known_scalar_ranges: tuple[tuple[int, int], ...]
    mark_scalar_ranges: tuple[tuple[int, int], ...]
    token_scalar_ranges: tuple[tuple[int, int], ...]
    hangul_decomposition: HangulDecomposition
    compatibility_decomposition_mappings: tuple[tuple[int, str], ...]
    lowercase_mappings: tuple[tuple[int, str], ...]
    case_folds: tuple[tuple[str, str], ...]
    minimum_admitted_scalar_count: int
    query_token_policy: str


@dataclass(frozen=True)
class NormalizedSpeciesSearch:
    text: str
    tokens: tuple[str, ...]
    scalar_count: int


def load_contract(
    *,
    root: Path | None = None,
) -> SpeciesSearchNormalizationContract:
    authority_path = (
        AUTHORITY_PATH
        if root is None
        else root / "canopi-types/species-search-normalization.json"
    )
    try:
        raw: Any = json.loads(authority_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"failed to read Species Search normalization authority {authority_path}: {error}"
        ) from error
    if not isinstance(raw, dict):
        raise RuntimeError("Species Search normalization authority root must be an object")

    expected_root_keys = {
        "contract_format_version",
        "normalization_version",
        "unicode_data",
        "algorithm",
        "corpus",
    }
    missing_root_keys = sorted(expected_root_keys - raw.keys())
    unknown_root_keys = sorted(raw.keys() - expected_root_keys)
    if missing_root_keys:
        raise RuntimeError(
            f"root: missing required property {missing_root_keys[0]!r}"
        )
    if unknown_root_keys:
        raise RuntimeError(f"root: unknown property {unknown_root_keys[0]!r}")
    if raw["contract_format_version"] != 1:
        raise RuntimeError("contract_format_version must equal 1")

    version = raw.get("normalization_version")
    unicode_data = raw.get("unicode_data")
    algorithm = raw.get("algorithm")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise RuntimeError("normalization_version must be a positive integer")
    if not isinstance(unicode_data, dict):
        raise RuntimeError("unicode_data must be an object")
    expected_unicode_data_keys = {
        "version",
        "facts_file",
    }
    missing_unicode_data_keys = sorted(expected_unicode_data_keys - unicode_data.keys())
    unknown_unicode_data_keys = sorted(unicode_data.keys() - expected_unicode_data_keys)
    if missing_unicode_data_keys:
        raise RuntimeError(
            f"unicode_data: missing required property {missing_unicode_data_keys[0]!r}"
        )
    if unknown_unicode_data_keys:
        raise RuntimeError(
            f"unicode_data: unknown property {unknown_unicode_data_keys[0]!r}"
        )
    unicode_data_version = unicode_data["version"]
    if not isinstance(unicode_data_version, str) or not unicode_data_version:
        raise RuntimeError("unicode_data.version must be nonempty text")
    facts_file = unicode_data["facts_file"]
    if (
        not isinstance(facts_file, str)
        or not facts_file
        or Path(facts_file).name != facts_file
    ):
        raise RuntimeError("unicode_data.facts_file must be a local filename")
    facts_path = authority_path.parent / facts_file
    try:
        facts: Any = json.loads(facts_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"failed to read Species Search Unicode facts {facts_path}: {error}"
        ) from error
    if not isinstance(facts, dict):
        raise RuntimeError("Unicode facts root must be an object")
    expected_facts_keys = {
        "facts_format_version",
        "unicode_data_version",
        "known_scalar_ranges",
        "mark_scalar_ranges",
        "token_scalar_ranges",
        "hangul_decomposition",
        "compatibility_decomposition_mappings",
        "lowercase_mappings",
    }
    missing_facts_keys = sorted(expected_facts_keys - facts.keys())
    unknown_facts_keys = sorted(facts.keys() - expected_facts_keys)
    if missing_facts_keys:
        raise RuntimeError(
            f"unicode facts: missing required property {missing_facts_keys[0]!r}"
        )
    if unknown_facts_keys:
        raise RuntimeError(
            f"unicode facts: unknown property {unknown_facts_keys[0]!r}"
        )
    if facts["facts_format_version"] != 2:
        raise RuntimeError("unicode facts format version must equal 2")
    if facts["unicode_data_version"] != unicode_data_version:
        raise RuntimeError(
            "unicode facts version must equal the authored Unicode data version"
        )

    def admit_ranges(key: str) -> tuple[tuple[int, int], ...]:
        value = facts[key]
        if not isinstance(value, list) or not value:
            raise RuntimeError(f"unicode_data.{key} must be a nonempty array")
        ranges: list[tuple[int, int]] = []
        previous_end = -1
        for index, raw_range in enumerate(value):
            if (
                not isinstance(raw_range, list)
                or len(raw_range) != 2
                or any(
                    isinstance(scalar, bool) or not isinstance(scalar, int)
                    for scalar in raw_range
                )
            ):
                raise RuntimeError(
                    f"unicode_data.{key}[{index}] must be a two-integer range"
                )
            start, end = raw_range
            if start < 0 or end > 0x10FFFF or start > end or start <= previous_end:
                raise RuntimeError(
                    f"unicode_data.{key}[{index}] must be an ordered, disjoint Unicode scalar range"
                )
            if start <= 0xDFFF and end >= 0xD800:
                raise RuntimeError(
                    f"unicode_data.{key}[{index}] must not contain surrogate code points"
                )
            ranges.append((start, end))
            previous_end = end
        return tuple(ranges)

    known_scalar_ranges = admit_ranges("known_scalar_ranges")
    mark_scalar_ranges = admit_ranges("mark_scalar_ranges")
    token_scalar_ranges = admit_ranges("token_scalar_ranges")

    def range_contains(ranges: tuple[tuple[int, int], ...], scalar: int) -> bool:
        for start, end in ranges:
            if scalar < start:
                return False
            if scalar <= end:
                return True
        return False

    def range_is_covered(
        ranges: tuple[tuple[int, int], ...],
        required_start: int,
        required_end: int,
    ) -> bool:
        next_required = required_start
        for start, end in ranges:
            if end < next_required:
                continue
            if start > next_required:
                return False
            if end >= required_end:
                return True
            next_required = end + 1
        return False

    for key, ranges in (
        ("mark_scalar_ranges", mark_scalar_ranges),
        ("token_scalar_ranges", token_scalar_ranges),
    ):
        for start, end in ranges:
            if not range_is_covered(known_scalar_ranges, start, end):
                raise RuntimeError(
                    f"unicode_data.{key} must be contained by known_scalar_ranges"
                )

    raw_hangul = facts["hangul_decomposition"]
    expected_hangul_keys = {
        "s_base",
        "l_base",
        "v_base",
        "t_base",
        "l_count",
        "v_count",
        "t_count",
    }
    if not isinstance(raw_hangul, dict) or set(raw_hangul) != expected_hangul_keys:
        raise RuntimeError("unicode_data.hangul_decomposition has an invalid shape")
    if any(
        isinstance(value, bool) or not isinstance(value, int) or value < 1
        for value in raw_hangul.values()
    ):
        raise RuntimeError("unicode_data.hangul_decomposition values must be positive integers")
    hangul_decomposition = HangulDecomposition(**raw_hangul)
    standard_hangul_decomposition = HangulDecomposition(
        s_base=0xAC00,
        l_base=0x1100,
        v_base=0x1161,
        t_base=0x11A7,
        l_count=19,
        v_count=21,
        t_count=28,
    )
    if hangul_decomposition != standard_hangul_decomposition:
        raise RuntimeError(
            "Unicode Hangul decomposition facts must equal the standard constants"
        )
    hangul_scalar_count = (
        hangul_decomposition.l_count
        * hangul_decomposition.v_count
        * hangul_decomposition.t_count
    )
    if (
        hangul_decomposition.s_base + hangul_scalar_count > 0x110000
        or not range_is_covered(
            known_scalar_ranges,
            hangul_decomposition.s_base,
            hangul_decomposition.s_base + hangul_scalar_count - 1,
        )
    ):
        raise RuntimeError("Unicode Hangul syllables must be contained by known scalars")

    def admit_mappings(key: str) -> tuple[tuple[int, str], ...]:
        raw_mappings = facts[key]
        if not isinstance(raw_mappings, list) or not raw_mappings:
            raise RuntimeError(f"unicode_data.{key} must be a nonempty array")
        mappings: list[tuple[int, str]] = []
        previous_scalar = -1
        for index, raw_mapping in enumerate(raw_mappings):
            if (
                not isinstance(raw_mapping, list)
                or len(raw_mapping) != 2
                or isinstance(raw_mapping[0], bool)
                or not isinstance(raw_mapping[0], int)
                or not isinstance(raw_mapping[1], str)
                or not raw_mapping[1]
            ):
                raise RuntimeError(
                    f"unicode_data.{key}[{index}] must contain a scalar and nonempty text"
                )
            scalar, target = raw_mapping
            if scalar <= previous_scalar or not range_contains(known_scalar_ranges, scalar):
                raise RuntimeError(
                    f"unicode_data.{key} must have unique ordered known scalars"
                )
            if any(
                not range_contains(known_scalar_ranges, ord(character))
                for character in target
            ):
                raise RuntimeError(
                    f"unicode_data.{key}[{index}] target must contain known scalars"
                )
            mappings.append((scalar, target))
            previous_scalar = scalar
        return tuple(mappings)

    compatibility_decomposition_mappings = admit_mappings(
        "compatibility_decomposition_mappings"
    )
    lowercase_mappings = admit_mappings("lowercase_mappings")

    if not isinstance(algorithm, dict):
        raise RuntimeError("algorithm must be an object")
    expected_algorithm_keys = {
        "compatibility_decomposition",
        "stripped_general_categories",
        "token_character_classes",
        "case_folds",
        "minimum_admitted_scalar_count",
        "query_token_policy",
    }
    missing_algorithm_keys = sorted(expected_algorithm_keys - algorithm.keys())
    unknown_algorithm_keys = sorted(algorithm.keys() - expected_algorithm_keys)
    if missing_algorithm_keys:
        raise RuntimeError(
            f"algorithm: missing required property {missing_algorithm_keys[0]!r}"
        )
    if unknown_algorithm_keys:
        raise RuntimeError(
            f"algorithm: unknown property {unknown_algorithm_keys[0]!r}"
        )
    expected_algorithm = {
        "compatibility_decomposition": "NFKD",
        "stripped_general_categories": ["Mn", "Mc", "Me"],
        "token_character_classes": ["Letter", "Number", "Underscore"],
        "query_token_policy": "unique-admitted-or-all-when-active",
    }
    for key, expected in expected_algorithm.items():
        if algorithm.get(key) != expected:
            raise RuntimeError(f"algorithm.{key} must equal {expected!r}")

    raw_case_folds = algorithm.get("case_folds")
    if not isinstance(raw_case_folds, list) or not raw_case_folds:
        raise RuntimeError("algorithm.case_folds must be a nonempty array")
    case_folds: list[tuple[str, str]] = []
    seen_sources: set[str] = set()
    for index, raw_case_fold in enumerate(raw_case_folds):
        if not isinstance(raw_case_fold, dict) or set(raw_case_fold) != {"from", "to"}:
            raise RuntimeError(
                f"algorithm.case_folds[{index}] must contain only 'from' and 'to'"
            )
        source = raw_case_fold["from"]
        target = raw_case_fold["to"]
        if not isinstance(source, str) or not source:
            raise RuntimeError(f"algorithm.case_folds[{index}].from must be nonempty text")
        if not isinstance(target, str) or not target:
            raise RuntimeError(f"algorithm.case_folds[{index}].to must be nonempty text")
        if source in seen_sources:
            raise RuntimeError(f"algorithm.case_folds has duplicate source {source!r}")
        seen_sources.add(source)
        case_folds.append((source, target))

    minimum = algorithm.get("minimum_admitted_scalar_count")
    if isinstance(minimum, bool) or not isinstance(minimum, int) or minimum < 1:
        raise RuntimeError(
            "algorithm.minimum_admitted_scalar_count must be a positive integer"
        )

    corpus = raw.get("corpus")
    if not isinstance(corpus, list) or not corpus:
        raise RuntimeError("corpus must be a nonempty array")
    expected_case_keys = {
        "name",
        "input",
        "normalized_text",
        "tokens",
        "query_tokens",
        "admission",
    }
    seen_case_names: set[str] = set()
    for index, case in enumerate(corpus):
        if not isinstance(case, dict):
            raise RuntimeError(f"corpus[{index}] must be an object")
        if set(case) != expected_case_keys:
            missing = sorted(expected_case_keys - case.keys())
            unknown = sorted(case.keys() - expected_case_keys)
            detail = (
                f"missing required property {missing[0]!r}"
                if missing
                else f"unknown property {unknown[0]!r}"
            )
            raise RuntimeError(f"corpus[{index}]: {detail}")
        name = case["name"]
        if not isinstance(name, str) or not name or name in seen_case_names:
            raise RuntimeError(f"corpus[{index}].name must be nonempty and unique")
        seen_case_names.add(name)
        if not isinstance(case["input"], str):
            raise RuntimeError(f"corpus[{index}].input must be text")
        if not isinstance(case["normalized_text"], str):
            raise RuntimeError(f"corpus[{index}].normalized_text must be text")
        if not isinstance(case["tokens"], list) or not all(
            isinstance(token, str) and token for token in case["tokens"]
        ):
            raise RuntimeError(
                f"corpus[{index}].tokens must be an array of nonempty text"
            )
        if not isinstance(case["query_tokens"], list) or not all(
            isinstance(token, str) and token for token in case["query_tokens"]
        ):
            raise RuntimeError(
                f"corpus[{index}].query_tokens must be an array of nonempty text"
            )
        if case["admission"] not in {admission.value for admission in SpeciesSearchAdmission}:
            raise RuntimeError(f"corpus[{index}].admission is unsupported")

    canonical = json.dumps(
        {"authority": raw, "unicode_facts": facts},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return SpeciesSearchNormalizationContract(
        version=version,
        fingerprint=hashlib.sha256(canonical).hexdigest(),
        unicode_data_version=unicode_data_version,
        known_scalar_ranges=known_scalar_ranges,
        mark_scalar_ranges=mark_scalar_ranges,
        token_scalar_ranges=token_scalar_ranges,
        hangul_decomposition=hangul_decomposition,
        compatibility_decomposition_mappings=compatibility_decomposition_mappings,
        lowercase_mappings=lowercase_mappings,
        case_folds=tuple(case_folds),
        minimum_admitted_scalar_count=minimum,
        query_token_policy=algorithm["query_token_policy"],
    )


CONTRACT = load_contract()
_KNOWN_RANGE_STARTS = tuple(start for start, _end in CONTRACT.known_scalar_ranges)
_MARK_RANGE_STARTS = tuple(start for start, _end in CONTRACT.mark_scalar_ranges)
_TOKEN_RANGE_STARTS = tuple(start for start, _end in CONTRACT.token_scalar_ranges)
_DECOMPOSITION_BY_SCALAR = dict(CONTRACT.compatibility_decomposition_mappings)
_LOWERCASE_BY_SCALAR = dict(CONTRACT.lowercase_mappings)


def _range_contains(
    ranges: tuple[tuple[int, int], ...],
    starts: tuple[int, ...],
    scalar: int,
) -> bool:
    index = bisect_right(starts, scalar) - 1
    return index >= 0 and scalar <= ranges[index][1]


def normalize_species_search(raw: str) -> NormalizedSpeciesSearch:
    decomposed_parts: list[str] = []
    hangul = CONTRACT.hangul_decomposition
    hangul_scalar_count = hangul.l_count * hangul.v_count * hangul.t_count
    for character in raw:
        scalar = ord(character)
        if not _range_contains(
            CONTRACT.known_scalar_ranges,
            _KNOWN_RANGE_STARTS,
            scalar,
        ):
            decomposed_parts.append(" ")
            continue
        decomposition = _DECOMPOSITION_BY_SCALAR.get(scalar)
        if decomposition is not None:
            decomposed_parts.append(decomposition)
            continue
        hangul_index = scalar - hangul.s_base
        if 0 <= hangul_index < hangul_scalar_count:
            trailing_index = hangul_index % hangul.t_count
            vowel_index = (hangul_index // hangul.t_count) % hangul.v_count
            leading_index = hangul_index // (hangul.v_count * hangul.t_count)
            decomposed_parts.append(
                "".join(
                    chr(part)
                    for part in (
                        hangul.l_base + leading_index,
                        hangul.v_base + vowel_index,
                        *((hangul.t_base + trailing_index,) if trailing_index else ()),
                    )
                )
            )
        else:
            decomposed_parts.append(character)
    decomposed = "".join(decomposed_parts)
    folded = "".join(
        _LOWERCASE_BY_SCALAR.get(ord(character), character)
        for character in decomposed
        if not _range_contains(
            CONTRACT.mark_scalar_ranges,
            _MARK_RANGE_STARTS,
            ord(character),
        )
    )
    for source, target in CONTRACT.case_folds:
        folded = folded.replace(source, target)

    tokens: list[str] = []
    token: list[str] = []
    for character in folded:
        if character == "_" or _range_contains(
            CONTRACT.token_scalar_ranges,
            _TOKEN_RANGE_STARTS,
            ord(character),
        ):
            token.append(character)
        elif token:
            tokens.append("".join(token))
            token.clear()
    if token:
        tokens.append("".join(token))

    return NormalizedSpeciesSearch(
        text=" ".join(tokens),
        tokens=tuple(tokens),
        scalar_count=sum(len(token) for token in tokens),
    )


def common_name_tokens(name: str) -> list[tuple[str, int]]:
    return [
        (token, index)
        for index, token in enumerate(normalize_species_search(name).tokens)
    ]


def normalize_search_name(name: str) -> str:
    return normalize_species_search(name).text


def species_search_admission(raw: str) -> SpeciesSearchAdmission:
    scalar_count = normalize_species_search(raw).scalar_count
    if scalar_count == 0:
        return SpeciesSearchAdmission.BROWSE
    if scalar_count < CONTRACT.minimum_admitted_scalar_count:
        return SpeciesSearchAdmission.TOO_SHORT
    return SpeciesSearchAdmission.ACTIVE_TEXT


def species_search_query_tokens(raw: str) -> tuple[str, ...]:
    normalized = normalize_species_search(raw)
    if normalized.scalar_count < CONTRACT.minimum_admitted_scalar_count:
        return ()
    unique_tokens = tuple(dict.fromkeys(normalized.tokens))
    admitted_tokens = tuple(
        token
        for token in unique_tokens
        if len(token) >= CONTRACT.minimum_admitted_scalar_count
    )
    return admitted_tokens or unique_tokens
