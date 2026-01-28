import unittest
from core.types.global_error import GlobalError


class TestGlobalError(unittest.TestCase):
    def test_init_with_message(self):
        err = GlobalError("something went wrong")
        self.assertEqual(err.message, "something went wrong")
        self.assertEqual(err.context['message'], "something went wrong")
        self.assertEqual(err.code, 500)

    def test_init_with_none(self):
        err = GlobalError(None)
        self.assertIsNone(err.message)
        self.assertIsNone(err.context['message'])

    def test_init_default(self):
        err = GlobalError()
        self.assertIsNone(err.message)

    def test_setCode(self):
        err = GlobalError("test")
        err.setCode(404)
        self.assertEqual(err.code, 404)
        self.assertEqual(err.context['code'], 404)

    def test_setJson(self):
        err = GlobalError("test")
        json_data = {"field": "value", "details": "info"}
        err.setJson(json_data)
        self.assertEqual(err.context['json'], json_data)

    def test_setStack(self):
        err = GlobalError("test")
        err.setStack("at line 42\nat line 55")
        self.assertEqual(err.context['stack'], "at line 42\nat line 55")

    def test_setName(self):
        err = GlobalError("test")
        err.setName("MyNode")
        self.assertEqual(err.context['name'], "MyNode")

    def test_hasJson_true(self):
        err = GlobalError("test")
        err.setJson({"key": "val"})
        self.assertTrue(err.hasJson())

    def test_hasJson_false(self):
        err = GlobalError("test")
        self.assertFalse(err.hasJson())

    def test_str_with_json(self):
        err = GlobalError("test")
        err.setJson({"error": "detail"})
        self.assertEqual(str(err), str({"error": "detail"}))

    def test_str_without_json(self):
        err = GlobalError("plain message")
        self.assertEqual(str(err), "plain message")

    def test_str_none_message(self):
        err = GlobalError(None)
        self.assertEqual(str(err), "")

    def test_to_dict(self):
        err = GlobalError("test error")
        err.setCode(422)
        err.setJson({"field": "invalid"})
        err.setStack("traceback here")
        err.setName("Validator")
        result = err.to_dict()
        self.assertEqual(result['message'], "test error")
        self.assertEqual(result['code'], 422)
        self.assertEqual(result['json'], {"field": "invalid"})
        self.assertEqual(result['stack'], "traceback here")
        self.assertEqual(result['name'], "Validator")

    def test_is_exception(self):
        err = GlobalError("test")
        self.assertIsInstance(err, Exception)

    def test_init_converts_non_string_to_string(self):
        err = GlobalError(123)
        self.assertEqual(err.message, "123")


if __name__ == '__main__':
    unittest.main()
