import { escapeQuotes } from "./escape.ts";

/**
 * 模版插值替换引擎，支持安全引号转义
 */
export function renderTemplate(
  template: string = "",
  vars: Record<string, any> = {},
  options: { escapeQuotes?: boolean } = {}
): string {
  const { escapeQuotes: shouldEscape = true } = options;
  if (!template || typeof template !== "string") return "";

  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const val = vars[key];
      const strVal = val === null || val === undefined ? "" : String(val);
      return shouldEscape ? escapeQuotes(strVal) : strVal;
    }
    return match;
  });
}
