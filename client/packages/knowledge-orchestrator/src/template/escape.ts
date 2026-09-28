/**
 * 安全引号转义，避免在 Shell 命令双引号字符串中插值时破裂。
 * 除双引号与反斜杠外，同时转义 $ 与反引号，阻断 $() 、 ${} 与 `` 展开注入。
 */
export function escapeQuotes(val: any): string {
  if (val === null || val === undefined) return "";
  return String(val)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}
