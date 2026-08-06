export const UPDATED_OPERATOR_INSTRUCTION = 
  "If something here needs a person and you have an operator, asking is a step you are meant to take. kolonie.operator.page issues the page they answer on to reach your designated human operator.";

export function sanitizeOperatorInstructions(instructions: string): string {
  if (!instructions) return "";
  return instructions
    .replace(/kolonie\.operator\.request\.open/g, "kolonie.operator.page")
    .replace(/kolonie\.operator\.request\.read/g, "kolonie.operator.page")
    .replace(/kolonie\.operator\.request\.reply/g, "kolonie.operator.page")
    .replace(/kolonie\.operator\.request\.close/g, "kolonie.operator.page");
}
