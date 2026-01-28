import unittest
from unittest.mock import patch, AsyncMock, MagicMock
import asyncio
import json
import base64


class TestNodeService(unittest.TestCase):
    @patch('server.Runner')
    def test_execute_node_success(self, MockRunner):
        from server import NodeService

        mock_response = MagicMock()
        mock_response.to_dict = MagicMock(return_value={"data": {"result": "ok"}, "success": True})

        mock_runner_instance = MagicMock()
        mock_runner_instance.run = AsyncMock(return_value=mock_response)
        MockRunner.return_value = mock_runner_instance

        service = NodeService()

        # Create mock request
        ctx_data = {"request": {"body": {}}}
        b64_msg = base64.b64encode(json.dumps(ctx_data).encode()).decode()
        mock_request = MagicMock()
        mock_request.Name = "test-node"
        mock_request.Message = b64_msg
        mock_request.Encoding = "BASE64"
        mock_request.Type = "JSON"

        result = asyncio.run(service.ExecuteNode(mock_request, None))
        self.assertEqual(result.Encoding, "BASE64")
        self.assertEqual(result.Type, "JSON")
        self.assertIsNotNone(result.Message)

    @patch('server.Runner')
    def test_execute_node_exception(self, MockRunner):
        from server import NodeService

        MockRunner.side_effect = Exception("Node execution failed")

        service = NodeService()

        ctx_data = {"request": {}}
        b64_msg = base64.b64encode(json.dumps(ctx_data).encode()).decode()
        mock_request = MagicMock()
        mock_request.Name = "fail-node"
        mock_request.Message = b64_msg
        mock_request.Encoding = "BASE64"
        mock_request.Type = "JSON"

        result = asyncio.run(service.ExecuteNode(mock_request, None))
        self.assertEqual(result.Encoding, "BASE64")
        self.assertEqual(result.Type, "JSON")
        # Decode the error response
        decoded = json.loads(base64.b64decode(result.Message).decode())
        self.assertIn("error", decoded)

    @patch('server.Runner')
    def test_execute_node_json_exception(self, MockRunner):
        from server import NodeService

        # Exception with JSON-parseable message
        json_error = json.dumps({"code": 422, "message": "Validation failed"})
        MockRunner.side_effect = Exception(json_error)

        service = NodeService()

        ctx_data = {"request": {}}
        b64_msg = base64.b64encode(json.dumps(ctx_data).encode()).decode()
        mock_request = MagicMock()
        mock_request.Name = "fail-node"
        mock_request.Message = b64_msg
        mock_request.Encoding = "BASE64"
        mock_request.Type = "JSON"

        result = asyncio.run(service.ExecuteNode(mock_request, None))
        decoded = json.loads(base64.b64decode(result.Message).decode())
        self.assertEqual(decoded["code"], 422)
        self.assertEqual(decoded["message"], "Validation failed")


class TestServe(unittest.TestCase):
    @patch('server.grpc.aio.server')
    @patch('server.node_pb2_grpc.add_NodeServiceServicer_to_server')
    def test_serve_starts_server(self, mock_add_servicer, mock_server_fn):
        from server import serve

        mock_server = AsyncMock()
        mock_server.add_insecure_port = MagicMock()
        mock_server.start = AsyncMock()
        mock_server.wait_for_termination = AsyncMock(side_effect=asyncio.CancelledError())
        mock_server.stop = AsyncMock()
        mock_server_fn.return_value = mock_server

        asyncio.run(serve())

        mock_server_fn.assert_called_once()
        mock_add_servicer.assert_called_once()
        mock_server.start.assert_called_once()
        mock_server.stop.assert_called_once()

    @patch('server.grpc.aio.server')
    @patch('server.node_pb2_grpc.add_NodeServiceServicer_to_server')
    def test_serve_uses_env_port(self, mock_add_servicer, mock_server_fn):
        import os
        from server import serve

        original = os.environ.get("SERVER_PORT")
        os.environ["SERVER_PORT"] = "9999"

        mock_server = AsyncMock()
        mock_server.add_insecure_port = MagicMock()
        mock_server.start = AsyncMock()
        mock_server.wait_for_termination = AsyncMock(side_effect=asyncio.CancelledError())
        mock_server.stop = AsyncMock()
        mock_server_fn.return_value = mock_server

        asyncio.run(serve())

        mock_server.add_insecure_port.assert_called_with("0.0.0.0:9999")

        if original is not None:
            os.environ["SERVER_PORT"] = original
        else:
            del os.environ["SERVER_PORT"]


if __name__ == '__main__':
    unittest.main()
