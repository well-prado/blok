/**
 * Integration Test Setup
 *
 * This file runs before all integration tests to:
 * - Check Docker availability
 * - Verify Python runtime availability
 * - Set up test environment variables
 * - Configure logging for tests
 */

import { execSync } from 'node:child_process';
import { beforeAll, afterAll } from 'vitest';

// Environment detection
const isDockerAvailable = (): boolean => {
  try {
    execSync('docker --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const isPythonAvailable = (): boolean => {
  try {
    execSync('python3 --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// Global setup
beforeAll(() => {
  console.log('\n🧪 Integration Test Environment Setup\n');

  // Check Docker availability
  if (isDockerAvailable()) {
    console.log('✅ Docker is available');
    process.env.DOCKER_AVAILABLE = 'true';
  } else {
    console.warn('⚠️  Docker is NOT available - Docker tests will be skipped');
    process.env.DOCKER_AVAILABLE = 'false';
  }

  // Check Python availability
  if (isPythonAvailable()) {
    console.log('✅ Python3 is available');
    process.env.PYTHON3_AVAILABLE = 'true';
  } else {
    console.warn('⚠️  Python3 is NOT available - Python tests will be skipped');
    process.env.PYTHON3_AVAILABLE = 'false';
  }

  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error'; // Reduce noise in tests

  // Runtime configuration for tests (HTTP SDK ports)
  process.env.RUNTIME_PYTHON3_HOST = 'localhost';
  process.env.RUNTIME_PYTHON3_PORT = '9007';

  console.log('\n✅ Integration test environment ready\n');
});

// Global teardown
afterAll(() => {
  console.log('\n🧹 Cleaning up integration test environment\n');
});

// Helper to skip tests when Docker is not available
export const skipIfNoDocker = () => {
  if (process.env.DOCKER_AVAILABLE !== 'true') {
    return { skip: true, reason: 'Docker not available' };
  }
  return { skip: false };
};

// Helper to skip tests when Python is not available
export const skipIfNoPython = () => {
  if (process.env.PYTHON3_AVAILABLE !== 'true') {
    return { skip: true, reason: 'Python3 not available' };
  }
  return { skip: false };
};
