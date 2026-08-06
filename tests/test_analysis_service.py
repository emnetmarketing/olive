import unittest

from services.analysis_service import analyze_trends, best_product_match, summary_metrics


class AnalysisServiceTest(unittest.TestCase):
    def test_detects_surge_and_product_match(self):
        social = [{"keyword": "아크멜로 비타 세럼", "today": 12000, "yesterday": 100}]
        products = [{"brand": "아크멜로", "title_clean": "비타 세럼"}]
        result = analyze_trends(social, products, surge_threshold=10000, yesterday_max=500, match_threshold=70)
        self.assertTrue(bool(result.iloc[0]["is_surge"]))
        self.assertTrue(bool(result.iloc[0]["matched"]))
        self.assertEqual(summary_metrics(result)["surges"], 1)

    def test_rejects_missing_columns(self):
        with self.assertRaises(ValueError):
            analyze_trends([{"keyword": "세럼"}], [])

    def test_empty_product_match(self):
        self.assertEqual(best_product_match("세럼", []), ("", "", 0.0))


if __name__ == "__main__":
    unittest.main()
