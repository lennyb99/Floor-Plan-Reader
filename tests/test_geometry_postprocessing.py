import unittest

import numpy as np
from shapely.geometry import LineString
from shapely.ops import unary_union

from product.segmentation.geometry_pipeline.image_to_json_pipeline import (
    coalesce_near_parallel_lines,
    connect_loose_ends,
)
from product.segmentation.geometry_pipeline.pipeline_runner import (
    assign_thickness,
    normalize_wall_thicknesses,
)


class GeometryPostprocessingTests(unittest.TestCase):
    def test_only_facing_collinear_endpoints_bridge_long_opening(self):
        lines = [
            LineString([(20, 20), (20, 180)]),
            LineString([(20, 270), (20, 500)]),
            # Nearby but pointing away; it must not steal either endpoint.
            LineString([(35, 180), (80, 180)]),
        ]
        repaired = connect_loose_ends(lines, max_dist=125)
        repaired_union = unary_union(repaired)

        # The 90 px vertical opening and the nearby 15 px T-junction are both
        # repaired without changing their axes.
        self.assertTrue(repaired_union.covers(LineString([(20, 180), (20, 270)])))
        self.assertTrue(repaired_union.covers(LineString([(20, 180), (35, 180)])))

    def test_connector_wall_receives_visible_fallback_thickness(self):
        distance_map = np.zeros((100, 100), dtype=np.float32)
        distance_map[45:55, 5:40] = 5.0
        lines = [
            LineString([(5, 50), (35, 50)]),
            LineString([(40, 50), (90, 50)]),  # mostly outside source mask
        ]

        walls = assign_thickness(lines, distance_map)

        self.assertTrue(all(wall.thickness_px >= 4.0 for wall in walls))
        self.assertGreater(walls[1].thickness_px, 4.0)

    def test_does_not_close_a_deliberate_setback_opening(self):
        lines = [
            LineString([(20, 20), (20, 100)]),
            LineString([(20, 130), (100, 130)]),
        ]

        repaired = unary_union(connect_loose_ends(lines, max_dist=125))

        self.assertFalse(repaired.covers(LineString([(20, 100), (20, 130)])))

    def test_near_parallel_overlapping_strokes_become_one_wall_axis(self):
        lines = [
            LineString([(20, 100), (220, 100)]),
            LineString([(80, 108), (260, 108)]),
            LineString([(20, 140), (220, 140)]),
        ]

        result = coalesce_near_parallel_lines(lines)

        self.assertEqual(len(result), 2)
        axes = sorted(round(line.coords[0][1], 1) for line in result)
        self.assertGreater(axes[1] - axes[0], 30)
        merged = min(result, key=lambda line: abs(line.coords[0][1] - 104))
        self.assertLessEqual(min(x for x, _ in merged.coords), 20)
        self.assertGreaterEqual(max(x for x, _ in merged.coords), 260)

    def test_non_overlapping_nearby_axes_are_not_coalesced(self):
        lines = [
            LineString([(20, 100), (80, 100)]),
            LineString([(120, 108), (180, 108)]),
        ]

        self.assertEqual(len(coalesce_near_parallel_lines(lines)), 2)

    def test_wall_thickness_is_normalized_to_robust_plan_median(self):
        distance_map = np.zeros((100, 100), dtype=np.float32)
        distance_map[10:90, :] = 5.0
        walls = assign_thickness([
            LineString([(5, 20), (95, 20)]),
            LineString([(5, 40), (95, 40)]),
        ], distance_map)
        walls[0].thickness_px = 6.0
        walls[1].thickness_px = 14.0

        normalized = normalize_wall_thicknesses(walls)

        self.assertEqual({wall.thickness_px for wall in normalized}, {10.0})


if __name__ == "__main__":
    unittest.main()
