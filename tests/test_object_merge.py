import unittest

import cv2
import numpy as np

from product.backend.objectsToWalls import merge, normalize_furniture_class
from product.backend.detection_ensemble import detect_stair_candidate, merge_detection_sets


class ObjectMergeTests(unittest.TestCase):
    def test_opening_width_uses_extent_along_wall(self):
        wall_data = {
            "walls": [{
                "id": "wall_1",
                "start": {"x": 0, "y": 20},
                "end": {"x": 200, "y": 20},
                "thickness": 10,
                "doors": [],
                "windows": [],
            }]
        }
        detections = {"detections": [{
            "name": "Tuer",
            "confidence": 0.9,
            "bbox": {"xmin": 40, "ymin": 5, "xmax": 80, "ymax": 65},
        }]}

        result = merge(wall_data, detections)
        door = result["walls"][0]["doors"][0]
        self.assertEqual(door["opening_width"], 40)
        self.assertEqual(door["center"]["y"], 20)

    def test_square_bed_prediction_is_normalized_to_stove(self):
        self.assertEqual(normalize_furniture_class("Bett", 58, 47), "Herd")
        self.assertEqual(normalize_furniture_class("Bett", 89, 52), "Bett")
        self.assertEqual(normalize_furniture_class("Bett", 90, 69), "Bett")

    def test_furniture_starts_with_default_size_and_wall_edge_rotation(self):
        wall_data = {
            "walls": [{
                "id": "wall_1",
                "start": {"x": 20, "y": 100},
                "end": {"x": 180, "y": 100},
                "thickness": 12,
                "doors": [],
                "windows": [],
            }]
        }
        detections = {"detections": [self._detection("Toilette", 0.91, 84, 109, 116, 160)]}

        result = merge(wall_data, detections)
        item = result["furniture"][0]

        self.assertEqual(item["width"], 22)
        self.assertEqual(item["height"], 34)
        self.assertEqual(item["attachment"]["wall_edge"], "bottom")
        self.assertEqual(item["rotation"], 0)
        self.assertEqual(item["center"]["y"], 123)
        self.assertIn("raw_bbox", item)

    def test_furniture_rotates_toward_vertical_wall_edge(self):
        wall_data = {
            "walls": [{
                "id": "wall_1",
                "start": {"x": 100, "y": 20},
                "end": {"x": 100, "y": 180},
                "thickness": 12,
                "doors": [],
                "windows": [],
            }]
        }
        detections = {"detections": [self._detection("Waschbecken", 0.88, 108, 84, 150, 116)]}

        result = merge(wall_data, detections)
        item = result["furniture"][0]

        self.assertEqual(item["attachment"]["wall_edge"], "right")
        self.assertEqual(item["rotation"], -90)

    def test_complementary_high_confidence_sanitary_detection_is_added(self):
        primary = [self._detection("Bett", 0.92, 100, 100, 200, 180)]
        fallback = [self._detection("Toilette", 0.86, 20, 220, 65, 280)]

        merged = merge_detection_sets(primary, fallback, 0.30)

        self.assertEqual([item["name"] for item in merged], ["Bett", "Toilette"])

    def test_low_confidence_fallback_false_positive_is_rejected(self):
        fallback = [self._detection("Toilette", 0.36, 20, 220, 65, 280)]
        self.assertEqual(merge_detection_sets([], fallback, 0.30), [])

    def test_overlapping_door_from_fallback_is_deduplicated(self):
        primary = [self._detection("Tuer", 0.70, 100, 100, 145, 155)]
        fallback = [self._detection("Doppeltuer", 0.82, 104, 103, 148, 158)]
        self.assertEqual(len(merge_detection_sets(primary, fallback, 0.30)), 1)

    def test_regular_treads_recover_missing_stair(self):
        image = np.full((512, 512, 3), 255, dtype=np.uint8)
        for y in range(180, 245, 10):
            cv2.line(image, (190, y), (270, y), (0, 0, 0), 3)

        detections = detect_stair_candidate(image, [])

        self.assertEqual(len(detections), 1)
        self.assertEqual(detections[0]["name"], "Treppe")

    def test_existing_yolo_stair_suppresses_geometry_fallback(self):
        image = np.full((512, 512, 3), 255, dtype=np.uint8)
        existing = [self._detection("Treppe", 0.7, 100, 100, 200, 250)]
        self.assertEqual(detect_stair_candidate(image, existing), [])

    @staticmethod
    def _detection(name, confidence, xmin, ymin, xmax, ymax):
        return {
            "name": name,
            "confidence": confidence,
            "bbox": {"xmin": xmin, "ymin": ymin, "xmax": xmax, "ymax": ymax},
        }


if __name__ == "__main__":
    unittest.main()
