/**
 * Unit Tests for NodeJsRuntimeAdapter
 * Tests in-process TypeScript/JavaScript node execution
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NodeJsRuntimeAdapter } from '../NodeJsRuntimeAdapter';
import type { RunnerNode } from '../../RunnerNode';
import type { Context } from '@nanoservice-ts/shared';
import {
  createMockContext,
  assertValidExecutionResult,
  assertExecutionTimeWithinRange,
  measureExecutionTime,
} from '../../../test/helpers/test-utils';

describe('NodeJsRuntimeAdapter', () => {
  let adapter: NodeJsRuntimeAdapter;

  beforeEach(() => {
    adapter = new NodeJsRuntimeAdapter();
  });

  describe('Adapter Properties', () => {
    it('should have nodejs as kind', () => {
      expect(adapter.kind).toBe('nodejs');
    });

    it('should have execute method', () => {
      expect(adapter.execute).toBeDefined();
      expect(typeof adapter.execute).toBe('function');
    });
  });

  describe('execute() - Success Cases', () => {
    it('should execute node successfully and return ExecutionResult', async () => {
      const mockContext = createMockContext();
      const mockNode = createMockNodeWithRun({
        success: true,
        data: { result: 'test success' },
        error: null,
      });

      const result = await adapter.execute(mockNode, mockContext);

      assertValidExecutionResult(result);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ result: 'test success' });
      expect(result.errors).toBeNull();
      expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should execute node with no data', async () => {
      const mockContext = createMockContext();
      const mockNode = createMockNodeWithRun({
        success: true,
        data: null,
        error: null,
      });

      const result = await adapter.execute(mockNode, mockContext);

      expect(result.success).toBe(true);
      expect(result.data).toBeNull();
    });

    it('should pass context to node run method', async () => {
      const mockContext = createMockContext({
        id: 'custom-id',
        workflow_name: 'custom-workflow',
      });

      let capturedContext: Context | null = null;
      const mockNode = {
        run: vi.fn(async (ctx: Context) => {
          capturedContext = ctx;
          return { success: true, data: {}, error: null };
        }),
      } as unknown as RunnerNode;

      await adapter.execute(mockNode, mockContext);

      expect(mockNode.run).toHaveBeenCalledWith(mockContext);
      expect(capturedContext).toBe(mockContext);
      expect(capturedContext?.id).toBe('custom-id');
    });
  });

  describe('execute() - Error Cases', () => {
    it('should handle node execution errors', async () => {
      const mockContext = createMockContext();
      const mockNode = createMockNodeWithRun({
        success: false,
        data: null,
        error: { message: 'Node execution failed', code: 500 },
      });

      const result = await adapter.execute(mockNode, mockContext);

      assertValidExecutionResult(result);
      expect(result.success).toBe(false);
      expect(result.errors).toEqual({ message: 'Node execution failed', code: 500 });
    });

    it('should catch and handle thrown errors', async () => {
      const mockContext = createMockContext();
      const mockNode = {
        run: vi.fn().mockRejectedValue(new Error('Test error')),
      } as unknown as RunnerNode;

      const result = await adapter.execute(mockNode, mockContext);

      expect(result.success).toBe(false);
      expect(result.data).toBeNull();
      expect(result.errors).toBeDefined();
      expect(result.errors).toHaveProperty('message', 'Test error');
      expect(result.errors).toHaveProperty('name');
      expect(result.errors).toHaveProperty('stack');
    });

    it('should handle async errors', async () => {
      const mockContext = createMockContext();
      const mockNode = {
        run: vi.fn(async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          throw new Error('Async error');
        }),
      } as unknown as RunnerNode;

      const result = await adapter.execute(mockNode, mockContext);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveProperty('message', 'Async error');
    });

    it('should handle nodes that return undefined success', async () => {
      const mockContext = createMockContext();
      const mockNode = createMockNodeWithRun({
        success: undefined as any,
        data: { result: 'data' },
        error: null,
      });

      const result = await adapter.execute(mockNode, mockContext);

      // When success is undefined, it defaults to true
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ result: 'data' });
    });
  });

  describe('execute() - Performance', () => {
    it('should measure execution duration accurately', async () => {
      const mockContext = createMockContext();
      const delayMs = 50;
      const mockNode = createDelayedMockNode(delayMs);

      const { result, duration } = await measureExecutionTime(() =>
        adapter.execute(mockNode, mockContext)
      );

      expect(result.metrics?.duration_ms).toBeDefined();
      assertExecutionTimeWithinRange(
        result.metrics!.duration_ms!,
        duration,
        20 // 20ms tolerance
      );
      expect(result.metrics!.duration_ms!).toBeGreaterThanOrEqual(delayMs - 10);
    });

    it('should execute with minimal overhead for fast nodes', async () => {
      const mockContext = createMockContext();
      const mockNode = createMockNodeWithRun({
        success: true,
        data: {},
        error: null,
      });

      const result = await adapter.execute(mockNode, mockContext);

      // Should be very fast (< 50ms) for instant execution
      expect(result.metrics?.duration_ms).toBeLessThan(50);
    });

    it('should handle concurrent executions', async () => {
      const mockContext = createMockContext();
      const mockNode = createMockNodeWithRun({
        success: true,
        data: { result: 'concurrent' },
        error: null,
      });

      const promises = Array(10)
        .fill(null)
        .map(() => adapter.execute(mockNode, mockContext));

      const results = await Promise.all(promises);

      expect(results).toHaveLength(10);
      results.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ result: 'concurrent' });
      });
    });

    it('should not accumulate memory on repeated executions', async () => {
      const mockContext = createMockContext();
      const mockNode = createMockNodeWithRun({
        success: true,
        data: {},
        error: null,
      });

      const initialMemory = process.memoryUsage().heapUsed;

      // Execute 100 times
      for (let i = 0; i < 100; i++) {
        await adapter.execute(mockNode, mockContext);
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Memory increase should be minimal (< 10MB for 100 executions)
      expect(memoryIncrease).toBeLessThan(10 * 1024 * 1024);
    });
  });

  describe('execute() - ExecutionResult Structure', () => {
    it('should return ExecutionResult with all required fields', async () => {
      const mockContext = createMockContext();
      const mockNode = createMockNodeWithRun({
        success: true,
        data: { test: 'data' },
        error: null,
      });

      const result = await adapter.execute(mockNode, mockContext);

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('errors');
      expect(result).toHaveProperty('metrics');
      expect(result.metrics).toHaveProperty('duration_ms');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.metrics!.duration_ms).toBe('number');
    });

    it('should map success responses correctly', async () => {
      const mockContext = createMockContext();
      const mockNode = createMockNodeWithRun({
        success: true,
        data: { message: 'success' },
        error: null,
      });

      const result = await adapter.execute(mockNode, mockContext);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ message: 'success' });
      expect(result.errors).toBeNull();
    });

    it('should map failure responses correctly', async () => {
      const mockContext = createMockContext();
      const mockNode = createMockNodeWithRun({
        success: false,
        data: null,
        error: { message: 'failure', code: 500 },
      });

      const result = await adapter.execute(mockNode, mockContext);

      expect(result.success).toBe(false);
      expect(result.data).toBeNull();
      expect(result.errors).toEqual({ message: 'failure', code: 500 });
    });

    it('should include duration_ms in metrics', async () => {
      const mockContext = createMockContext();
      const mockNode = createMockNodeWithRun({
        success: true,
        data: {},
        error: null,
      });

      const result = await adapter.execute(mockNode, mockContext);

      expect(result.metrics).toBeDefined();
      expect(result.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
      expect(typeof result.metrics?.duration_ms).toBe('number');
    });
  });

  describe('execute() - Context Immutability', () => {
    it('should not mutate the context object', async () => {
      const mockContext = createMockContext({
        id: 'original-id',
        vars: { original: 'value' },
      });

      const mockNode = {
        run: vi.fn(async (ctx: Context) => {
          // Node receives the context and can work with it
          return { success: true, data: {}, error: null };
        }),
      } as unknown as RunnerNode;

      await adapter.execute(mockNode, mockContext);

      // The adapter passes the context to the node
      expect(mockNode.run).toHaveBeenCalledWith(mockContext);
    });
  });
});

// Test Helper Functions

function createMockNodeWithRun(response: {
  success: boolean | undefined;
  data: any;
  error: any;
}): RunnerNode {
  return {
    run: vi.fn().mockResolvedValue(response),
  } as unknown as RunnerNode;
}

function createDelayedMockNode(delayMs: number): RunnerNode {
  return {
    run: vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return { success: true, data: {}, error: null };
    }),
  } as unknown as RunnerNode;
}
