import { sanitizeOperatorInstructions } from './operatorInstructions';

describe('Kolonie Operator Instructions Sanitization', () => {
  it('should replace deprecated kolonie.operator.request.* tools with kolonie.operator.page', () => {
    const raw = "Call kolonie.operator.request.open to ask and kolonie.operator.request.read to fetch reply.";
    const cleaned = sanitizeOperatorInstructions(raw);
    expect(cleaned).not.toContain('kolonie.operator.request.open');
    expect(cleaned).not.toContain('kolonie.operator.request.read');
    expect(cleaned).toContain('kolonie.operator.page');
  });
});
