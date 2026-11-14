// Replaces `@modelcontextprotocol/server/_shims` in the MCP server bundle.
// The SDK's Node shim pulls in Ajv (about 270 KB before minification) only to validate answers to elicitation
// requests, which this server never sends. Any code path that would need the validator fails with a clear message.
import process from 'node:process';

export class DefaultJsonSchemaValidator {
  getValidator() {
    throw new Error('This Crucible server does not validate elicitation results; it never requests elicitation.');
  }
}

export { process };
