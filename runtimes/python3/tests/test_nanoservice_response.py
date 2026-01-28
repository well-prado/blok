import unittest
from core.types.nanoservice_response import NanoServiceResponse
from core.types.global_error import GlobalError


class TestNanoServiceResponse(unittest.TestCase):
    def test_default_init(self):
        resp = NanoServiceResponse()
        self.assertEqual(resp.steps, [])
        self.assertEqual(resp.data, {})
        self.assertIsNone(resp.error)
        self.assertTrue(resp.success)
        self.assertEqual(resp.contentType, "application/json")

    def test_setError(self):
        resp = NanoServiceResponse()
        err = GlobalError("something failed")
        resp.setError(err)
        self.assertEqual(resp.error, err)
        self.assertFalse(resp.success)
        self.assertEqual(resp.data, {})

    def test_setSuccess(self):
        resp = NanoServiceResponse()
        resp.setSuccess({"result": "ok"})
        self.assertEqual(resp.data, {"result": "ok"})
        self.assertIsNone(resp.error)
        self.assertTrue(resp.success)

    def test_setSuccess_after_error(self):
        resp = NanoServiceResponse()
        resp.setError(GlobalError("fail"))
        resp.setSuccess({"recovered": True})
        self.assertEqual(resp.data, {"recovered": True})
        self.assertIsNone(resp.error)
        self.assertTrue(resp.success)

    def test_to_dict_success(self):
        resp = NanoServiceResponse()
        resp.setSuccess({"key": "value"})
        d = resp.to_dict()
        self.assertEqual(d['data'], {"key": "value"})
        self.assertIsNone(d['error'])
        self.assertTrue(d['success'])
        self.assertEqual(d['contentType'], "application/json")

    def test_to_dict_error(self):
        resp = NanoServiceResponse()
        err = GlobalError("broken")
        err.setCode(422)
        resp.setError(err)
        d = resp.to_dict()
        self.assertEqual(d['data'], {})
        self.assertIsNotNone(d['error'])
        self.assertEqual(d['error']['message'], "broken")
        self.assertFalse(d['success'])


if __name__ == '__main__':
    unittest.main()
