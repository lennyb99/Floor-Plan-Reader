import unittest

import cv2
import numpy as np

from training.structural_metrics import boundary_scores, structural_wall_metrics


class StructuralWallMetricsTests(unittest.TestCase):
    def setUp(self):
        self.target = np.zeros((128, 128), dtype=np.uint8)
        cv2.line(self.target, (16, 32), (112, 32), 255, 7)
        cv2.line(self.target, (64, 32), (64, 112), 255, 7)

    def test_identical_masks_are_perfect(self):
        metrics = structural_wall_metrics(self.target, self.target)
        self.assertAlmostEqual(metrics["boundary_f1"], 1.0)
        self.assertAlmostEqual(metrics["topology_score"], 1.0)
        self.assertEqual(metrics["component_error"], 0)
        self.assertEqual(metrics["endpoint_error"], 0)

    def test_boundary_tolerance_accepts_small_shift(self):
        shifted = np.roll(self.target, 2, axis=0)
        tolerant = boundary_scores(shifted, self.target, tolerance_px=3)
        strict = boundary_scores(shifted, self.target, tolerance_px=0)
        self.assertGreater(tolerant["boundary_f1"], strict["boundary_f1"])
        self.assertGreater(tolerant["boundary_f1"], 0.95)

    def test_wall_gap_is_visible_in_topology(self):
        broken = self.target.copy()
        broken[28:37, 84:94] = 0
        metrics = structural_wall_metrics(broken, self.target)
        self.assertGreater(metrics["component_error"], 0)
        self.assertGreater(metrics["endpoint_error"], 0)
        self.assertLess(metrics["topology_score"], 1.0)


if __name__ == "__main__":
    unittest.main()
