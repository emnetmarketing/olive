import os
import unittest

from components.config import secret_bool
from models.schemas import UserProfile
from services.settings_service import _validate


class SettingsAndPermissionsTest(unittest.TestCase):
    def test_roles(self):
        master = UserProfile("1", "m@example.com", "M", "master", "approved")
        editor = UserProfile("2", "e@example.com", "E", "editor", "approved")
        pending = UserProfile("3", "p@example.com", "P", "master", "pending")
        self.assertTrue(master.is_master)
        self.assertTrue(editor.can_edit)
        self.assertFalse(pending.is_master)

    def test_retention_is_bounded(self):
        self.assertEqual(_validate("retention", {"days": 0, "max_records": 1}), {"days": 1, "max_records": 10})
        self.assertEqual(_validate("retention", {"days": 99999, "max_records": 999999}), {"days": 3650, "max_records": 100000})

    def test_environment_boolean(self):
        os.environ["TEST_COOKIE_FLAG"] = "false"
        self.assertFalse(secret_bool("TEST_COOKIE_FLAG", True))
        os.environ.pop("TEST_COOKIE_FLAG", None)


if __name__ == "__main__":
    unittest.main()
