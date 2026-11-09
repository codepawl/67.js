import * as z from 'zod/v4';
import { describeReceived } from '../src/field-error.js';

const ISSUES_WITH_A_REJECTED_VALUE = new Set(['too_big', 'too_small', 'invalid_value', 'invalid_format', 'not_multiple_of']);

// The SDK prefixes each schema message with the field path (recipe.materials.0.color.2). The English wording says what
// was expected ("Too big: expected number to be <=1") but not what arrived, so the received value is added here.
function messageWithReceivedValue(issue) {
  const wording = z.locales.en().localeError(issue);
  const text = typeof wording === 'string' ? wording : wording?.message;
  if (!text) {
    return undefined;
  }
  if (ISSUES_WITH_A_REJECTED_VALUE.has(issue.code) && Object.hasOwn(issue, 'input')) {
    return `${text} (got ${describeReceived(issue.input)})`;
  }
  return undefined;
}

export function describeSchemaInputsWithReceivedValues() {
  z.config({ customError: messageWithReceivedValue });
}
