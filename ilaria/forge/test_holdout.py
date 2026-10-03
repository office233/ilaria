import unittest
from forge.holdout import sample_key, partition_samples


class HoldoutTests(unittest.TestCase):
    def test_disjoint_and_stable_across_order(self):
        rows = [{"turns": [(f"Question {i}", "answer")]} for i in range(500)]
        train = {sample_key(x) for x in partition_samples(rows)}
        val = {sample_key(x) for x in partition_samples(reversed(rows), validation=True)}
        self.assertTrue(train and val)
        self.assertFalse(train & val)
        self.assertEqual(len(train | val), len(rows))

    def test_changed_answer_does_not_leak_same_prompt(self):
        self.assertEqual(sample_key({"turns": [("HELLO", "one")]}),
                         sample_key({"turns": [("hello", "two")]}))

    def test_image_sets_cannot_leak_shared_images(self):
        class Image:
            size = (1, 1)
            def __init__(self, value): self.value = value
            def convert(self, mode): return self
            def tobytes(self): return bytes([self.value] * 3)
        rows = [{"images": [Image(i)]} for i in range(100)]
        train = list(partition_samples(rows, fraction=0.5))
        val = list(partition_samples(rows, validation=True, fraction=0.5))
        mixed = {"images": train[0]["images"] + val[0]["images"]}
        self.assertEqual(list(partition_samples([mixed], fraction=0.5)), [])
        self.assertEqual(list(partition_samples([mixed], validation=True, fraction=0.5)), [])
