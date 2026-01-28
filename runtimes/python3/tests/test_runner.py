import unittest
from unittest.mock import patch, AsyncMock, MagicMock
import asyncio
from core.types.context import Context
from core.types.response import ResponseContext


class TestRunner(unittest.TestCase):
    @patch('runner.get_nodes')
    def test_init(self, mock_get_nodes):
        mock_get_nodes.return_value = {'node1': MagicMock()}
        from runner import Runner
        ctx = {
            'id': 'test-id',
            'request': {'body': {}},
            'response': {},
            'config': {'name': 'node1'},
        }
        runner = Runner('node1', ctx)
        self.assertEqual(runner.node_name, 'node1')
        self.assertIsInstance(runner.ctx, Context)

    @patch('runner.get_nodes')
    def test_create_context(self, mock_get_nodes):
        mock_get_nodes.return_value = {}
        from runner import Runner
        ctx_data = {
            'id': 'ctx-123',
            'workflow_name': 'wf-1',
            'workflow_path': '/path',
            'request': {'body': {'key': 'val'}},
            'response': {'data': 'ok'},
            'error': None,
            'logger': None,
            'config': {'node': 'test'},
            'func': {'fn': lambda: None},
            'vars': {'x': 1},
            'env': {'NODE_ENV': 'test'},
        }
        runner = Runner('test', ctx_data)
        self.assertEqual(runner.ctx.id, 'ctx-123')
        self.assertEqual(runner.ctx.workflow_name, 'wf-1')
        self.assertEqual(runner.ctx.request['body']['key'], 'val')
        self.assertEqual(runner.ctx.vars['x'], 1)
        self.assertEqual(runner.ctx.env['NODE_ENV'], 'test')

    @patch('runner.get_nodes')
    def test_create_context_defaults(self, mock_get_nodes):
        mock_get_nodes.return_value = {}
        from runner import Runner
        runner = Runner('test', {})
        self.assertEqual(runner.ctx.id, '')
        self.assertEqual(runner.ctx.request, {})
        self.assertEqual(runner.ctx.vars, {})

    @patch('runner.get_nodes')
    def test_node_resolver(self, mock_get_nodes):
        mock_node = MagicMock()
        mock_get_nodes.return_value = {'my-node': mock_node}
        from runner import Runner
        runner = Runner('my-node', {
            'config': {'node': 'my-node', 'name': 'step1', 'active': True, 'stop': False, 'set_var': True}
        })
        resolved = runner.node_resolver('my-node', runner.ctx.config)
        self.assertEqual(resolved.node, 'my-node')
        self.assertEqual(resolved.name, 'step1')
        self.assertTrue(resolved.active)
        self.assertFalse(resolved.stop)
        self.assertTrue(resolved.set_var)

    @patch('runner.get_nodes')
    def test_node_resolver_defaults(self, mock_get_nodes):
        mock_node = MagicMock()
        mock_get_nodes.return_value = {'my-node': mock_node}
        from runner import Runner
        runner = Runner('my-node', {'config': {}})
        resolved = runner.node_resolver('my-node', {})
        self.assertTrue(resolved.active)
        self.assertFalse(resolved.stop)
        self.assertFalse(resolved.set_var)

    @patch('runner.get_nodes')
    def test_run(self, mock_get_nodes):
        mock_response = ResponseContext()
        mock_response.success = True
        mock_response.data = {"result": "done"}

        mock_node = MagicMock()
        mock_node.process = AsyncMock(return_value=mock_response)
        mock_get_nodes.return_value = {'my-node': mock_node}

        from runner import Runner
        runner = Runner('my-node', {
            'config': {'node': 'my-node', 'name': 'step1'}
        })
        result = asyncio.run(runner.run())
        self.assertTrue(result.success)
        self.assertEqual(result.data, {"result": "done"})

    @patch('runner.get_nodes')
    def test_run_node_not_found(self, mock_get_nodes):
        mock_get_nodes.return_value = {}
        from runner import Runner
        runner = Runner('missing-node', {'config': {}})
        with self.assertRaises(KeyError):
            asyncio.run(runner.run())


if __name__ == '__main__':
    unittest.main()
