import unittest
from core.types.context import Context


class TestContext(unittest.TestCase):
    def test_default_init(self):
        ctx = Context()
        self.assertEqual(ctx.id, "")
        self.assertEqual(ctx.workflow_name, "")
        self.assertEqual(ctx.workflow_path, "")
        self.assertEqual(ctx.request, {})
        self.assertEqual(ctx.vars, {})
        self.assertEqual(ctx.env, {})
        self.assertIsNone(ctx.logger)

    def test_set_fields(self):
        ctx = Context()
        ctx.id = "req-123"
        ctx.workflow_name = "my-workflow"
        ctx.request = {"body": {"key": "value"}}
        ctx.vars = {"x": 1}
        self.assertEqual(ctx.id, "req-123")
        self.assertEqual(ctx.workflow_name, "my-workflow")
        self.assertEqual(ctx.request["body"]["key"], "value")
        self.assertEqual(ctx.vars["x"], 1)

    def test_config_is_dict(self):
        ctx = Context()
        self.assertIsInstance(ctx.config, dict)


if __name__ == '__main__':
    unittest.main()
