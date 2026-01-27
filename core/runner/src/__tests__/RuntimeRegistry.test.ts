/**
 * Unit Tests for RuntimeRegistry
 * Tests the singleton registry pattern for runtime adapters
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RuntimeRegistry } from '../RuntimeRegistry';
import type { RuntimeAdapter, RuntimeKind } from '../adapters/RuntimeAdapter';
import { createMockRuntimeAdapter } from '../../test/helpers/test-utils';

describe('RuntimeRegistry', () => {
  let registry: RuntimeRegistry;

  beforeEach(() => {
    // Get fresh instance and clear all adapters before each test
    registry = RuntimeRegistry.getInstance();
    // Clear all registered adapters using the public clear() method
    registry.clear();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance on multiple calls', () => {
      const instance1 = RuntimeRegistry.getInstance();
      const instance2 = RuntimeRegistry.getInstance();
      const instance3 = RuntimeRegistry.getInstance();

      expect(instance1).toBe(instance2);
      expect(instance2).toBe(instance3);
      expect(instance1).toBe(instance3);
    });

    it('should maintain state across getInstance calls', () => {
      const instance1 = RuntimeRegistry.getInstance();
      const mockAdapter = createMockRuntimeAdapter('nodejs');

      instance1.register(mockAdapter);

      const instance2 = RuntimeRegistry.getInstance();
      expect(instance2.has('nodejs')).toBe(true);
    });
  });

  describe('register()', () => {
    it('should register a valid adapter', () => {
      const mockAdapter = createMockRuntimeAdapter('nodejs');

      registry.register(mockAdapter);

      expect(registry.has('nodejs')).toBe(true);
      expect(registry.get('nodejs')).toBe(mockAdapter);
    });

    it('should register multiple different adapters', () => {
      const nodejsAdapter = createMockRuntimeAdapter('nodejs');
      const python3Adapter = createMockRuntimeAdapter('python3');
      const goAdapter = createMockRuntimeAdapter('go');

      registry.register(nodejsAdapter);
      registry.register(python3Adapter);
      registry.register(goAdapter);

      expect(registry.has('nodejs')).toBe(true);
      expect(registry.has('python3')).toBe(true);
      expect(registry.has('go')).toBe(true);
    });

    it('should replace existing adapter with replace() method', () => {
      const adapter1 = createMockRuntimeAdapter('nodejs');
      const adapter2 = createMockRuntimeAdapter('nodejs');

      registry.register(adapter1);
      expect(registry.get('nodejs')).toBe(adapter1);

      registry.replace(adapter2);
      expect(registry.get('nodejs')).toBe(adapter2);
      expect(registry.get('nodejs')).not.toBe(adapter1);
    });

    it('should throw error when registering adapter twice', () => {
      const adapter1 = createMockRuntimeAdapter('nodejs');
      const adapter2 = createMockRuntimeAdapter('nodejs');

      registry.register(adapter1);
      expect(() => registry.register(adapter2)).toThrow(/already registered/);
    });

    it('should handle all supported runtime kinds', () => {
      const kinds: RuntimeKind[] = [
        'nodejs',
        'bun',
        'python3',
        'go',
        'java',
        'rust',
        'php',
        'csharp',
        'docker',
        'wasm',
      ];

      kinds.forEach(kind => {
        const adapter = createMockRuntimeAdapter(kind);
        registry.register(adapter);
        expect(registry.has(kind)).toBe(true);
      });

      expect(registry.getRegisteredKinds()).toEqual(kinds);
    });
  });

  describe('get()', () => {
    it('should return registered adapter', () => {
      const mockAdapter = createMockRuntimeAdapter('nodejs');
      registry.register(mockAdapter);

      const retrieved = registry.get('nodejs');

      expect(retrieved).toBe(mockAdapter);
      expect(retrieved.kind).toBe('nodejs');
    });

    it('should throw error when getting unregistered adapter', () => {
      expect(() => registry.get('rust')).toThrow();
      expect(() => registry.get('rust')).toThrow(/No runtime adapter registered/i);
    });

    it('should throw error with helpful message including runtime kind', () => {
      expect(() => registry.get('go')).toThrow(/go/i);
      expect(() => registry.get('java')).toThrow(/java/i);
    });

    it('should return different adapters for different kinds', () => {
      const nodejsAdapter = createMockRuntimeAdapter('nodejs');
      const python3Adapter = createMockRuntimeAdapter('python3');

      registry.register(nodejsAdapter);
      registry.register(python3Adapter);

      expect(registry.get('nodejs')).toBe(nodejsAdapter);
      expect(registry.get('python3')).toBe(python3Adapter);
      expect(registry.get('nodejs')).not.toBe(registry.get('python3'));
    });
  });

  describe('has()', () => {
    it('should return true for registered adapter', () => {
      const mockAdapter = createMockRuntimeAdapter('nodejs');
      registry.register(mockAdapter);

      expect(registry.has('nodejs')).toBe(true);
    });

    it('should return false for unregistered adapter', () => {
      expect(registry.has('rust')).toBe(false);
      expect(registry.has('php')).toBe(false);
      expect(registry.has('go')).toBe(false);
    });

    it('should return true after registration', () => {
      expect(registry.has('python3')).toBe(false);

      const mockAdapter = createMockRuntimeAdapter('python3');
      registry.register(mockAdapter);

      expect(registry.has('python3')).toBe(true);
    });

    it('should handle checks for all runtime kinds', () => {
      const kinds: RuntimeKind[] = ['nodejs', 'bun', 'python3', 'go'];

      kinds.forEach(kind => {
        expect(registry.has(kind)).toBe(false);
        registry.register(createMockRuntimeAdapter(kind));
        expect(registry.has(kind)).toBe(true);
      });
    });
  });

  describe('getRegisteredKinds()', () => {
    it('should return empty array when no adapters registered', () => {
      const kinds = registry.getRegisteredKinds();
      expect(kinds).toEqual([]);
      expect(kinds).toHaveLength(0);
    });

    it('should return array of registered runtime kinds', () => {
      registry.register(createMockRuntimeAdapter('nodejs'));
      registry.register(createMockRuntimeAdapter('python3'));
      registry.register(createMockRuntimeAdapter('go'));

      const kinds = registry.getRegisteredKinds();

      expect(kinds).toContain('nodejs');
      expect(kinds).toContain('python3');
      expect(kinds).toContain('go');
      expect(kinds).toHaveLength(3);
    });

    it('should return array with unique kinds only', () => {
      registry.register(createMockRuntimeAdapter('nodejs'));
      registry.replace(createMockRuntimeAdapter('nodejs')); // Replace

      const kinds = registry.getRegisteredKinds();

      expect(kinds.filter(k => k === 'nodejs')).toHaveLength(1);
      expect(kinds).toHaveLength(1);
    });

    it('should return kinds in order of registration', () => {
      registry.register(createMockRuntimeAdapter('java'));
      registry.register(createMockRuntimeAdapter('go'));
      registry.register(createMockRuntimeAdapter('python3'));
      registry.register(createMockRuntimeAdapter('nodejs'));

      const kinds = registry.getRegisteredKinds();

      expect(kinds[0]).toBe('java');
      expect(kinds[1]).toBe('go');
      expect(kinds[2]).toBe('python3');
      expect(kinds[3]).toBe('nodejs');
    });
  });

  describe('Adapter Validation', () => {
    it('should accept adapter with valid structure', () => {
      const validAdapter: RuntimeAdapter = {
        kind: 'nodejs',
        execute: vi.fn().mockResolvedValue({
          success: true,
          data: {},
          errors: null,
        }),
      };

      expect(() => registry.register(validAdapter)).not.toThrow();
      expect(registry.has('nodejs')).toBe(true);
    });

    it('should work with adapters that have additional methods', () => {
      const extendedAdapter = {
        kind: 'nodejs' as RuntimeKind,
        execute: vi.fn().mockResolvedValue({ success: true, data: {}, errors: null }),
        initialize: vi.fn(),
        cleanup: vi.fn(),
        healthCheck: vi.fn(),
      };

      expect(() => registry.register(extendedAdapter)).not.toThrow();
      expect(registry.get('nodejs')).toBe(extendedAdapter);
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent registrations', async () => {
      const adapters = [
        createMockRuntimeAdapter('nodejs'),
        createMockRuntimeAdapter('python3'),
        createMockRuntimeAdapter('go'),
        createMockRuntimeAdapter('java'),
      ];

      await Promise.all(adapters.map(adapter =>
        Promise.resolve(registry.register(adapter))
      ));

      expect(registry.getRegisteredKinds()).toHaveLength(4);
    });

    it('should handle concurrent get operations', async () => {
      registry.register(createMockRuntimeAdapter('nodejs'));

      const results = await Promise.all([
        Promise.resolve(registry.get('nodejs')),
        Promise.resolve(registry.get('nodejs')),
        Promise.resolve(registry.get('nodejs')),
      ]);

      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid replace operations', () => {
      registry.register(createMockRuntimeAdapter('nodejs'));

      for (let i = 0; i < 100; i++) {
        registry.replace(createMockRuntimeAdapter('nodejs'));
        expect(registry.has('nodejs')).toBe(true);
      }

      expect(registry.getRegisteredKinds()).toHaveLength(1);
    });

    it('should maintain registry state after errors', () => {
      registry.register(createMockRuntimeAdapter('nodejs'));

      // Try to get unregistered adapter (will throw)
      expect(() => registry.get('rust')).toThrow();

      // Registry should still work after error
      expect(registry.has('nodejs')).toBe(true);
      expect(registry.get('nodejs')).toBeDefined();
    });
  });
});
