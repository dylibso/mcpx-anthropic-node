import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ToolSchemaError } from '../src/index.ts';

describe('ToolSchemaError', () => {
  describe('parse', () => {
    test('should return original error if not a tool schema error', () => {
      const originalError = new Error('Not a schema error');
      assert.strictEqual(ToolSchemaError.parse(originalError), originalError);
    });

    test('should return original error if error type is not invalid_request_error', () => {
      const originalError = { 
        error: { 
          error: { 
            type: 'other_error', 
            message: 'tools.0.input_schema has an error' 
          } 
        } 
      };
      assert.strictEqual(ToolSchemaError.parse(originalError), originalError);
    });

    test('should return original error if message does not include input_schema', () => {
      const originalError = { 
        error: { 
          error: { 
            type: 'invalid_request_error', 
            message: 'some other error message' 
          } 
        } 
      };
      assert.strictEqual(ToolSchemaError.parse(originalError), originalError);
    });

    test('should return original error if message does not start with tools.', () => {
      const originalError = { 
        error: { 
          error: { 
            type: 'invalid_request_error', 
            message: 'input_schema has an error but not in the expected format' 
          } 
        } 
      };
      assert.strictEqual(ToolSchemaError.parse(originalError), originalError);
    });

    test('should return a ToolSchemaError when conditions are met', () => {
      const originalError = { 
        error: { 
          error: { 
            type: 'invalid_request_error', 
            message: 'tools.2.input_schema has invalid properties' 
          } 
        },
        message: 'Original error message'
      };
      
      const result = ToolSchemaError.parse(originalError);
      
      assert.ok(result instanceof ToolSchemaError);
      assert.strictEqual(result.originalError, originalError);
      assert.strictEqual(result.toolIndex, 2);
    });
  });

  describe('constructor', () => {
    test('should set originalError and toolIndex properties', () => {
      const originalError = new Error('Test error');
      const toolIndex = 3;
      
      const error = new ToolSchemaError(originalError, toolIndex);
      
      assert.strictEqual(error.originalError, originalError);
      assert.strictEqual(error.toolIndex, toolIndex);
    });

    test('should use the error message from the original error', () => {
      const originalError = new Error('Test error message');
      const toolIndex = 1;
      
      const error = new ToolSchemaError(originalError, toolIndex);
      
      assert.strictEqual(error.message, originalError.message);
    });

    test('should properly maintain instanceof checks', () => {
      const originalError = new Error('Test error');
      const toolIndex = 0;
      
      const error = new ToolSchemaError(originalError, toolIndex);
      
      assert.ok(error instanceof ToolSchemaError);
      assert.ok(error instanceof Error);
    });
  });
});