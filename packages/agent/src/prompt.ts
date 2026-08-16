/**
 * system prompt 组合（post-MVP 增补）：datedSystemPrompt 给基础 prompt 注入当前时间。
 *
 * 动机（2026-08-16 实测）：demo:real 问"今年是哪一年"，模型答"2025 年"——训练知识
 * 有截止，而它没有主动调用已注册的 bash 工具查 date。把当前时间直接写进 system
 * prompt 是零成本、确定性的兜底（工具仍可用，模型按需调用）。
 */
export function datedSystemPrompt(base: string): string {
  return `${base}\n当前时间（UTC）：${new Date().toISOString()}`
}
