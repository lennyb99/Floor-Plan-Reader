import unittest

import cv2
import numpy as np
from shapely.geometry import LineString

from product.segmentation.geometry_pipeline.image_to_json_pipeline import (
    extract_structural_ink_guides,
)


class StructuralInkGuideTests(unittest.TestCase):
    def test_extends_existing_wall_axis(self):
        image = np.full((160, 160, 3), 255, dtype=np.uint8)
        cv2.line(image, (15, 35), (145, 35), (0, 0, 0), 5)
        reference = [LineString([(15, 35), (70, 35)])]

        guides = extract_structural_ink_guides(image, reference)

        self.assertTrue(any(line.bounds[2] >= 135 for line in guides))

    def test_accepts_missing_axis_between_two_known_walls(self):
        image = np.full((180, 180, 3), 255, dtype=np.uint8)
        cv2.line(image, (90, 30), (90, 150), (0, 0, 0), 5)
        reference = [
            LineString([(20, 30), (155, 30)]),
            LineString([(20, 150), (155, 150)]),
        ]

        guides = extract_structural_ink_guides(image, reference)

        self.assertTrue(any(abs(line.coords[0][0] - 90) <= 5 for line in guides))

    def test_rejects_isolated_furniture_rectangle(self):
        image = np.full((180, 180, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (55, 55), (130, 120), (0, 0, 0), 5)
        reference = [LineString([(10, 15), (165, 15)])]

        guides = extract_structural_ink_guides(image, reference)

        self.assertEqual(guides, [])


if __name__ == "__main__":
    unittest.main()
