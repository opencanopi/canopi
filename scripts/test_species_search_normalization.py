import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest

from scripts import species_search_normalization as normalization
from scripts import species_search_unicode_facts as unicode_facts


SCRIPT_DIR = Path(__file__).parent
CONTRACT_PATH = SCRIPT_DIR.parent / "canopi-types/species-search-normalization.json"
UNICODE_FACTS_PATH = SCRIPT_DIR.parent / "canopi-types/species-search-unicode-15.json"


def load_script(filename: str, module_name: str):
    module_path = SCRIPT_DIR / filename
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare_db = load_script("prepare-db.py", "prepare_db_normalization_test")
generate_web_catalog = load_script(
    "generate-web-catalog.py",
    "generate_web_catalog_normalization_test",
)


class SpeciesSearchNormalizationTests(unittest.TestCase):
    def test_checked_in_unicode_facts_match_pinned_unicode_data(self):
        authored = json.loads(UNICODE_FACTS_PATH.read_text(encoding="utf-8"))

        self.assertEqual(
            authored,
            unicode_facts.compile_unicode_data(authored["unicode_data_version"]),
        )
        decompositions = dict(authored["compatibility_decomposition_mappings"])
        self.assertEqual(decompositions[0x1E030], "а")

    def test_runtimes_do_not_delegate_compatibility_decomposition_to_the_host(self):
        sources = {
            "Python": Path(normalization.__file__).read_text(encoding="utf-8"),
            "Rust": (
                SCRIPT_DIR.parent / "desktop/src/db/species_search_normalization.rs"
            ).read_text(encoding="utf-8"),
            "TypeScript": (
                SCRIPT_DIR.parent
                / "desktop/web/src/utils/species-search-normalization.ts"
            ).read_text(encoding="utf-8"),
        }

        self.assertNotIn("unicodedata.normalize", sources["Python"])
        self.assertNotIn(".nfkd()", sources["Rust"])
        self.assertNotIn(".normalize('NFKD')", sources["TypeScript"])

    def test_both_python_builders_match_the_authored_corpus(self):
        contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))

        for case in contract["corpus"]:
            with self.subTest(case=case["name"]):
                for builder in (prepare_db, generate_web_catalog):
                    self.assertEqual(
                        builder.normalize_search_name(case["input"]),
                        case["normalized_text"],
                    )
                    self.assertEqual(
                        [
                            token
                            for token, _position in builder.common_name_tokens(
                                case["input"]
                            )
                        ],
                        case["tokens"],
                    )

    def test_python_builders_share_one_normalization_implementation(self):
        self.assertIs(
            prepare_db.normalize_search_name,
            generate_web_catalog.normalize_search_name,
        )
        self.assertIs(
            prepare_db.common_name_tokens,
            generate_web_catalog.common_name_tokens,
        )

    def test_python_admission_matches_the_authored_corpus(self):
        contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))

        for case in contract["corpus"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(
                    normalization.species_search_admission(case["input"]).value,
                    case["admission"],
                )
                self.assertEqual(
                    normalization.species_search_query_tokens(case["input"]),
                    tuple(case["query_tokens"]),
                )

        self.assertEqual(
            normalization.CONTRACT.version,
            contract["normalization_version"],
        )
        self.assertRegex(normalization.CONTRACT.fingerprint, r"^[0-9a-f]{64}$")

    def test_python_and_bindings_generator_fingerprint_the_same_canonical_json(self):
        generated = (
            SCRIPT_DIR.parent
            / "desktop/web/src/generated/species-search-normalization.ts"
        ).read_text(encoding="utf-8")
        match = re.search(
            r'SPECIES_SEARCH_NORMALIZATION_FINGERPRINT = "([0-9a-f]{64})"',
            generated,
        )

        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), normalization.CONTRACT.fingerprint)

    def test_normalization_fingerprint_includes_generated_unicode_facts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            canopi_types = root / "canopi-types"
            canopi_types.mkdir(parents=True)
            (canopi_types / CONTRACT_PATH.name).write_text(
                CONTRACT_PATH.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            facts = json.loads(UNICODE_FACTS_PATH.read_text(encoding="utf-8"))
            facts["lowercase_mappings"][-1][1] = "a"
            (canopi_types / UNICODE_FACTS_PATH.name).write_text(
                json.dumps(facts),
                encoding="utf-8",
            )

            changed = normalization.load_contract(root=root)

        self.assertNotEqual(changed.fingerprint, normalization.CONTRACT.fingerprint)

    def test_authority_parser_rejects_unknown_semantic_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "canopi-types/species-search-normalization.json"
            path.parent.mkdir(parents=True)
            raw = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
            raw["algorithm"]["accidental_new_rule"] = True
            path.write_text(json.dumps(raw), encoding="utf-8")
            (path.parent / "species-search-unicode-15.json").write_text(
                UNICODE_FACTS_PATH.read_text(encoding="utf-8"),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                RuntimeError,
                r"algorithm.*unknown property.*accidental_new_rule",
            ):
                normalization.load_contract(root=root)

    def test_authority_parser_rejects_nonstandard_hangul_facts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            canopi_types = root / "canopi-types"
            canopi_types.mkdir(parents=True)
            (canopi_types / CONTRACT_PATH.name).write_text(
                CONTRACT_PATH.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            facts = json.loads(UNICODE_FACTS_PATH.read_text(encoding="utf-8"))
            facts["hangul_decomposition"]["l_base"] = 1
            (canopi_types / UNICODE_FACTS_PATH.name).write_text(
                json.dumps(facts),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(RuntimeError, r"Hangul.*standard"):
                normalization.load_contract(root=root)

    def test_authority_parser_rejects_property_ranges_outside_known_scalars(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            canopi_types = root / "canopi-types"
            canopi_types.mkdir(parents=True)
            (canopi_types / CONTRACT_PATH.name).write_text(
                CONTRACT_PATH.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            facts = json.loads(UNICODE_FACTS_PATH.read_text(encoding="utf-8"))
            facts["mark_scalar_ranges"] = [[0x10FFFF, 0x10FFFF]]
            (canopi_types / UNICODE_FACTS_PATH.name).write_text(
                json.dumps(facts),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(RuntimeError, r"contained by known_scalar_ranges"):
                normalization.load_contract(root=root)

    def test_authority_parser_rejects_property_range_spanning_unknown_gap(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            canopi_types = root / "canopi-types"
            canopi_types.mkdir(parents=True)
            (canopi_types / CONTRACT_PATH.name).write_text(
                CONTRACT_PATH.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            facts = json.loads(UNICODE_FACTS_PATH.read_text(encoding="utf-8"))
            facts["mark_scalar_ranges"] = [[887, 890]]
            (canopi_types / UNICODE_FACTS_PATH.name).write_text(
                json.dumps(facts),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(RuntimeError, r"contained by known_scalar_ranges"):
                normalization.load_contract(root=root)

    def test_authority_parser_requires_known_hangul_syllable_range(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            canopi_types = root / "canopi-types"
            canopi_types.mkdir(parents=True)
            (canopi_types / CONTRACT_PATH.name).write_text(
                CONTRACT_PATH.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            facts = json.loads(UNICODE_FACTS_PATH.read_text(encoding="utf-8"))
            for key in ("known_scalar_ranges", "token_scalar_ranges"):
                facts[key] = [
                    scalar_range
                    for scalar_range in facts[key]
                    if not scalar_range[0] <= 0xAC00 <= scalar_range[1]
                ]
            (canopi_types / UNICODE_FACTS_PATH.name).write_text(
                json.dumps(facts),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(RuntimeError, r"Hangul.*known scalars"):
                normalization.load_contract(root=root)


if __name__ == "__main__":
    unittest.main()
