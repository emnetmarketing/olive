import unittest
from datetime import date
from unittest.mock import Mock, patch

from services.naver_datalab_service import search_trends
from services.naver_news_service import search_news
from services.naver_shopping_service import search_shopping


class NaverServicesTest(unittest.TestCase):
    @patch("services.naver_common.secret", side_effect=lambda name, required=False: "configured")
    @patch("services.naver_common.httpx.request")
    def test_shopping_normalizes_title_and_hides_credentials(self, request, _secret):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"items": [{"title": "<b>비타</b> 세럼"}]}
        request.return_value = response
        items = search_shopping("비타 세럼")
        self.assertEqual(items[0]["title_clean"], "비타 세럼")
        kwargs = request.call_args.kwargs
        self.assertEqual(kwargs["headers"]["X-Naver-Client-Id"], "configured")
        self.assertNotIn("headers", items[0])

    @patch("services.naver_common.secret", side_effect=lambda name, required=False: "configured")
    @patch("services.naver_common.httpx.request")
    def test_news_normalizes_html(self, request, _secret):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"items": [{"title": "<b>뉴스</b>", "description": "새 <b>소식</b>"}]}
        request.return_value = response
        item = search_news("브랜드")[0]
        self.assertEqual(item["title_clean"], "뉴스")
        self.assertEqual(item["description_clean"], "새 소식")

    @patch("services.naver_common.secret", side_effect=lambda name, required=False: "configured")
    @patch("services.naver_common.httpx.request")
    def test_datalab_payload(self, request, _secret):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"results": [{"title": "세럼", "data": []}]}
        request.return_value = response
        result = search_trends(date(2026, 8, 1), date(2026, 8, 6), [{"groupName": "세럼", "keywords": ["비타 세럼"]}])
        self.assertEqual(result[0]["title"], "세럼")
        self.assertEqual(request.call_args.kwargs["json"]["startDate"], "2026-08-01")


if __name__ == "__main__":
    unittest.main()
