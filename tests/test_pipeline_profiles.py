import unittest

import cv2
import numpy as np

from product.backend.pipeline_profiles import (
    PIPELINE_PROFILES,
    classify_floorplan_style,
    resolve_pipeline_mode,
)
from product.segmentation.geometry_pipeline.pipeline_runner import GEOMETRY_PROFILES


class PipelineProfileTests(unittest.TestCase):
    def test_clean_orthogonal_plan_routes_to_professional_pipeline(self):
        image = np.full((512, 512, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (55, 60), (455, 450), (0, 0, 0), 5)
        cv2.line(image, (55, 240), (455, 240), (0, 0, 0), 4)
        cv2.line(image, (270, 60), (270, 450), (0, 0, 0), 4)

        decision = classify_floorplan_style(image)

        self.assertEqual(decision["resolved_mode"], "professional_plan")
        self.assertGreaterEqual(decision["confidence"], 0.5)

    def test_dense_black_professional_plan_is_not_mistaken_for_paper_texture(self):
        image = np.full((512, 512, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (30, 25), (480, 485), (0, 0, 0), 18)
        for x in (155, 310):
            cv2.line(image, (x, 25), (x, 485), (0, 0, 0), 14)
        for y in (180, 335):
            cv2.line(image, (30, y), (480, y), (0, 0, 0), 14)

        decision = classify_floorplan_style(image)

        self.assertEqual(decision["resolved_mode"], "professional_plan")

    def test_coloured_ink_on_textured_paper_routes_to_hand_pipeline(self):
        rng = np.random.default_rng(7)
        paper = rng.normal(205, 5, size=(512, 512, 1))
        image = np.repeat(np.clip(paper, 0, 255).astype(np.uint8), 3, axis=2)
        points = np.array([[45, 70], [120, 65], [210, 74], [315, 68], [450, 80]], np.int32)
        cv2.polylines(image, [points], False, (25, 55, 170), 7)
        cv2.line(image, (48, 75), (50, 430), (25, 55, 170), 7)

        decision = classify_floorplan_style(image)

        self.assertEqual(decision["resolved_mode"], "hand_sketch")

    def test_manual_mode_is_deterministic_and_keeps_profile(self):
        image = np.full((64, 64, 3), 255, dtype=np.uint8)

        routing = resolve_pipeline_mode("hand_sketch", image)

        self.assertEqual(routing["resolved_mode"], "hand_sketch")
        self.assertEqual(routing["confidence"], 1.0)
        self.assertIs(routing["profile"], PIPELINE_PROFILES["hand_sketch"])

    def test_professional_geometry_repairs_are_more_conservative(self):
        hand = GEOMETRY_PROFILES["hand_sketch"]
        professional = GEOMETRY_PROFILES["professional_plan"]

        self.assertGreater(hand["loose_end_max_dist"], professional["loose_end_max_dist"])
        self.assertGreater(hand["snap_tolerance_px"], professional["snap_tolerance_px"])
        self.assertTrue(hand["normalize_thickness"])
        self.assertFalse(professional["normalize_thickness"])
        self.assertTrue(hand["use_ink_guides"])
        self.assertFalse(professional["use_ink_guides"])


if __name__ == "__main__":
    unittest.main()
