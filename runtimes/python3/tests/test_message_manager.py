import unittest
import json
import base64
from xml.etree import ElementTree as ET
from util.message_manager import decode_message, encode_message


class MockPayload:
    """Mock gRPC request/response object."""
    def __init__(self, message, encoding, message_type):
        self.Message = message
        self.Encoding = encoding
        self.Type = message_type


class TestDecodeMessage(unittest.TestCase):
    def test_base64_json(self):
        data = {"request": {"body": {"key": "value"}}}
        b64 = base64.b64encode(json.dumps(data).encode("utf-8")).decode("utf-8")
        payload = MockPayload(b64, "BASE64", "JSON")
        result = decode_message(payload)
        self.assertEqual(result, data)

    def test_string_json(self):
        data = {"key": "value"}
        payload = MockPayload(json.dumps(data), "STRING", "JSON")
        result = decode_message(payload)
        self.assertEqual(result, data)

    def test_base64_xml(self):
        xml_str = "<root><item>test</item></root>"
        b64 = base64.b64encode(xml_str.encode("utf-8")).decode("utf-8")
        payload = MockPayload(b64, "BASE64", "XML")
        result = decode_message(payload)
        self.assertIsInstance(result, ET.Element)
        self.assertEqual(result.tag, "root")

    def test_string_xml(self):
        xml_str = "<data><val>123</val></data>"
        payload = MockPayload(xml_str, "STRING", "XML")
        result = decode_message(payload)
        self.assertIsInstance(result, ET.Element)
        self.assertEqual(result.tag, "data")

    def test_base64_text(self):
        text = "Hello, World!"
        b64 = base64.b64encode(text.encode("utf-8")).decode("utf-8")
        payload = MockPayload(b64, "BASE64", "TEXT")
        result = decode_message(payload)
        self.assertEqual(result, text)

    def test_string_text(self):
        payload = MockPayload("plain text", "STRING", "TEXT")
        result = decode_message(payload)
        self.assertEqual(result, "plain text")

    def test_base64_html(self):
        html = "<h1>Title</h1>"
        b64 = base64.b64encode(html.encode("utf-8")).decode("utf-8")
        payload = MockPayload(b64, "BASE64", "HTML")
        result = decode_message(payload)
        self.assertEqual(result, html)

    def test_string_html(self):
        payload = MockPayload("<p>content</p>", "STRING", "HTML")
        result = decode_message(payload)
        self.assertEqual(result, "<p>content</p>")

    def test_binary(self):
        raw = b"\x00\x01\x02\x03"
        b64 = base64.b64encode(raw).decode("utf-8")
        payload = MockPayload(b64, "BASE64", "BINARY")
        result = decode_message(payload)
        self.assertEqual(result, raw)

    def test_unsupported_encoding(self):
        payload = MockPayload("data", "UNKNOWN", "JSON")
        with self.assertRaises(ValueError) as ctx:
            decode_message(payload)
        self.assertIn("Unsupported encoding type", str(ctx.exception))

    def test_unsupported_type(self):
        payload = MockPayload("data", "STRING", "UNSUPPORTED")
        with self.assertRaises(ValueError) as ctx:
            decode_message(payload)
        self.assertIn("Unsupported message type", str(ctx.exception))


class TestEncodeMessage(unittest.TestCase):
    def test_json_dict(self):
        data = {"key": "value"}
        result = encode_message(data, "JSON")
        decoded = json.loads(base64.b64decode(result).decode("utf-8"))
        self.assertEqual(decoded, data)

    def test_json_with_to_dict(self):
        class HasToDict:
            def to_dict(self):
                return {"result": "ok"}

        result = encode_message(HasToDict(), "JSON")
        decoded = json.loads(base64.b64decode(result).decode("utf-8"))
        self.assertEqual(decoded, {"result": "ok"})

    def test_text(self):
        result = encode_message("hello world", "TEXT")
        decoded = base64.b64decode(result).decode("utf-8")
        self.assertEqual(decoded, "hello world")

    def test_html(self):
        html = "<h1>Title</h1>"
        result = encode_message(html, "HTML")
        decoded = base64.b64decode(result).decode("utf-8")
        self.assertEqual(decoded, html)

    def test_xml(self):
        root = ET.Element("root")
        child = ET.SubElement(root, "item")
        child.text = "test"
        result = encode_message(root, "XML")
        decoded = base64.b64decode(result).decode("utf-8")
        self.assertIn("root", decoded)
        self.assertIn("item", decoded)

    def test_binary(self):
        raw = b"\x00\x01\x02"
        result = encode_message(raw, "BINARY")
        # Result is base64(base64(raw))
        inner = base64.b64decode(result).decode("utf-8")
        self.assertEqual(base64.b64decode(inner), raw)

    def test_unsupported_type(self):
        with self.assertRaises(ValueError) as ctx:
            encode_message("data", "UNSUPPORTED")
        self.assertIn("Unsupported message type", str(ctx.exception))


if __name__ == '__main__':
    unittest.main()
