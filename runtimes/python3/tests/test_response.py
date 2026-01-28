import unittest
from core.types.response import ResponseContext
from core.types.global_error import GlobalError


class TestResponseContext(unittest.TestCase):
    def test_default_init(self):
        resp = ResponseContext()
        self.assertEqual(resp.data, {})
        self.assertIsNone(resp.error)
        self.assertFalse(resp.success)
        self.assertEqual(resp.contentType, "application/json")

    def test_init_with_values(self):
        err = GlobalError("err")
        resp = ResponseContext(data={"key": "val"}, error=err, success=True, contentType="text/html")
        self.assertEqual(resp.data, {"key": "val"})
        self.assertEqual(resp.error, err)
        self.assertTrue(resp.success)
        self.assertEqual(resp.contentType, "text/html")

    def test_to_dict_without_error(self):
        resp = ResponseContext(data={"result": 42}, success=True)
        d = resp.to_dict()
        self.assertEqual(d['data'], {"result": 42})
        self.assertIsNone(d['error'])
        self.assertTrue(d['success'])
        self.assertEqual(d['contentType'], "application/json")

    def test_to_dict_with_global_error(self):
        err = GlobalError("fail")
        err.setCode(500)
        resp = ResponseContext(error=err, success=False)
        d = resp.to_dict()
        self.assertIsNotNone(d['error'])
        self.assertEqual(d['error']['message'], "fail")
        self.assertFalse(d['success'])

    def test_to_dict_with_dict_error(self):
        resp = ResponseContext()
        resp.error = {"message": "dict error"}
        d = resp.to_dict()
        self.assertEqual(d['error'], {"message": "dict error"})

    def test_to_dict_with_string_error(self):
        resp = ResponseContext()
        resp.error = "string error"
        d = resp.to_dict()
        self.assertEqual(d['error'], {"message": "string error"})


if __name__ == '__main__':
    unittest.main()
