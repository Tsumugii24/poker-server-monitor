import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("audit", ROOT / "scripts/audit_hf_ranges.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class RootRangeAuditTests(unittest.TestCase):
    board = "AcKcQd"
    oop = "22,64s:0.500,53s,43s"
    ip = "AA,KK,AKs,AKo,Q5s:0.500,22"

    def payload(self):
        return {"ranges": {"oop_range": audit.expand_range(self.oop, self.board),
                           "ip_range": audit.expand_range(self.ip, self.board)}}

    def check(self, payload):
        return audit.classify(payload, self.oop, self.ip, self.board)

    def test_expands_classes_and_filters_exact_board_cards(self):
        combos = audit.expand_range("AA,AKs:0.500,AKo", self.board)
        self.assertEqual(len(combos), 12)  # 3 pairs, 3 suited, 6 offsuit
        self.assertEqual(sum(combos.values()), 10.5)
        self.assertEqual(combos[audit.combo_key("AdKd")], 0.5)
        self.assertTrue(all("Ac" not in k and "Kc" not in k for k in combos))

    def test_card_order_does_not_change_identity(self):
        self.assertEqual(audit.combo_key("AdKd"), audit.combo_key("KdAd"))
        payload = self.payload()
        payload["ranges"]["oop_range"] = {k[2:] + k[:2]: v
                                           for k, v in payload["ranges"]["oop_range"].items()}
        self.assertEqual(self.check(payload)["classification"], "valid")

    def test_detects_oop_using_entire_ip_range(self):
        payload = self.payload()
        payload["ranges"]["oop_range"] = payload["ranges"]["ip_range"]
        result = self.check(payload)
        self.assertEqual(result["classification"], "oop_equals_ip")
        self.assertGreater(result["oop"]["extra_count"], 0)
        self.assertGreater(result["oop"]["missing_count"], 0)
        self.assertTrue(result["ip"]["matches"])

    def test_detects_weight_error_with_identical_support(self):
        payload = self.payload()
        payload["ranges"]["oop_range"][audit.combo_key("6h4h")] = 1
        result = self.check(payload)
        self.assertEqual(result["classification"], "other_mismatch")
        self.assertEqual(result["oop"]["weight_mismatch_count"], 1)
        self.assertEqual(result["oop"]["missing_count"], 0)
        self.assertEqual(result["oop"]["extra_count"], 0)

    def test_does_not_audit_descendant_reach_probabilities_as_initial_ranges(self):
        payload = self.payload()
        payload["childrens"] = {"CHECK": {"ranges": {"oop_range": {"AdKd": 0.01}}}}
        self.assertEqual(self.check(payload)["classification"], "valid")

    def test_rejects_missing_root_range(self):
        with self.assertRaises(ValueError):
            self.check({"childrens": {"CHECK": self.payload()}})

    def test_rejects_invalid_input_and_duplicate_combos(self):
        for text in ("AA:2", "AA:nan", "AA,AA", "AAs", "AKx"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                audit.expand_range(text, self.board)
        with self.assertRaises(ValueError):
            audit.expand_range("AA", "AcAcQd")
        with self.assertRaises(ValueError):
            audit.normalized_combos({"AdKd": 1, "KdAd": 1})

    def test_reads_explicit_player_positions(self):
        document = {"player_positions": {"A": "IP", "B": "OOP"},
                    "A": {"raise": self.ip, "call": ""},
                    "B": {"raise": "", "call": self.oop}}
        self.assertEqual(audit.source_ranges(document), (self.oop, self.ip))
        document["player_positions"]["B"] = "IP"
        with self.assertRaises(ValueError):
            audit.source_ranges(document)


if __name__ == "__main__":
    unittest.main()
