import unittest

from forge.swypforge import build_tasks as bt


class BuildTasksTests(unittest.TestCase):
    def test_frozen_file_matches_builder(self):
        self.assertEqual(bt.OUT.read_bytes(), bt.render(bt.build()))

    def test_precedence_and_unary(self):
        self.assertEqual(bt.compile_pred("n / 10 % 10"),
                         {"op": "rem", "args": [{"op": "div", "args": [{"var": "n"}, {"const": {"type": "i64", "value": "10"}}]},
                                                {"const": {"type": "i64", "value": "10"}}]})
        self.assertEqual(bt.compile_pred("-3"), {"const": {"type": "i64", "value": "-3"}})
        p = bt.compile_pred("x < 0 || x > 9 || result == 1")
        self.assertEqual(p["op"], "or")
        self.assertEqual(p["args"][0]["op"], "or")
        with self.assertRaises(ValueError):
            bt.compile_pred("x == 1 )")

    def test_split_is_frozen(self):
        heldout = sorted(r["id"] for r in bt.build() if r["split"] == "heldout")
        self.assertEqual(heldout, sorted([
            "cube", "mod_three", "to_fahrenheit", "square_minus_x",
            "absolute", "clamp_0_50", "distance_to_ten", "grade", "flip_if_odd",
            "sum_squares", "digit_sum", "power_of_two", "integer_sqrt", "alternating_sum",
            "fib", "digital_root", "binary_length", "max3", "abs_diff", "safe_div"]))


if __name__ == "__main__":
    unittest.main()
