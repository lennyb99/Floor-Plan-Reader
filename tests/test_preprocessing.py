import unittest

import cv2
import numpy as np

from product.segmentation.preprocessing import apply_gamma, preprocess_floorplan


class PreprocessingTests(unittest.TestCase):
    def test_smart_crop_returns_exact_public_coordinate_space(self):
        image = np.full((400, 800, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (120, 40), (680, 360), (0, 0, 0), 8)

        result = preprocess_floorplan(image, gamma=1.25)

        self.assertEqual(result.image_rgb.shape, (512, 512, 3))
        self.assertEqual(result.metadata.output_width, 512)
        self.assertEqual(result.metadata.output_height, 512)
        self.assertAlmostEqual(result.metadata.gamma, 1.25)
        self.assertLess(np.min(result.image_rgb), 10)
        self.assertGreater(np.mean(result.image_rgb[:15]), 245)

    def test_gamma_darkens_midtones_but_keeps_paper_white(self):
        image = np.array([[[128, 128, 128], [255, 255, 255]]], dtype=np.uint8)
        corrected = apply_gamma(image, 1.5)
        self.assertLess(int(corrected[0, 0, 0]), 128)
        self.assertEqual(int(corrected[0, 1, 0]), 255)

    def test_blue_pen_on_grey_paper_is_cleaned_and_cropped_to_ink(self):
        image = np.full((500, 800, 3), 195, dtype=np.uint8)
        cv2.rectangle(image, (250, 140), (550, 360), (20, 55, 165), 6)

        result = preprocess_floorplan(image)

        self.assertTrue(result.metadata.cleanup_applied)
        self.assertLess(result.metadata.crop_size, 400)
        self.assertGreater(result.metadata.crop_left, 150)
        self.assertGreater(float(np.mean(result.image_rgb[:20])), 248)
        self.assertLess(int(np.min(result.image_rgb)), 40)

    def test_manual_crop_uses_exact_source_square(self):
        image = np.full((300, 500, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (220, 80), (300, 160), (0, 0, 0), -1)

        result = preprocess_floorplan(
            image,
            auto_crop=False,
            manual_crop=(200, 60, 120),
            cleanup_mode="off",
            gamma=1.0,
        )

        self.assertEqual(result.metadata.crop_mode, "manual")
        self.assertEqual(result.metadata.crop_left, 200)
        self.assertEqual(result.metadata.crop_top, 60)
        self.assertEqual(result.metadata.crop_size, 120)
        self.assertLess(int(np.min(result.image_rgb)), 5)

    def test_manual_crop_can_zoom_out_with_white_padding(self):
        image = np.full((100, 160, 3), 210, dtype=np.uint8)

        result = preprocess_floorplan(
            image,
            auto_crop=False,
            manual_crop=(-20, -50, 200),
            cleanup_mode="off",
            gamma=1.0,
        )

        self.assertEqual(result.metadata.crop_left, -20)
        self.assertEqual(result.metadata.crop_top, -50)
        self.assertEqual(result.metadata.crop_size, 200)
        self.assertGreater(float(np.mean(result.image_rgb[:80])), 250)
        self.assertGreater(float(np.mean(result.image_rgb[-80:])), 250)
        self.assertLess(float(np.mean(result.image_rgb[150:350, 60:450])), 240)


if __name__ == "__main__":
    unittest.main()
