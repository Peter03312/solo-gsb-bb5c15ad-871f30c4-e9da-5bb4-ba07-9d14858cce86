// 标签比较与序列化
//
// 标签内容允许包含 U+0001，因此不能用 U+0001（或其他可能出现在标签里的字符）
// 作为标签间分隔符拼接后再比较：['甲\u0001乙'] 与 ['甲', '乙'] 会拼成同一串，
// 导致单标签拆成两个标签时漏判。统一按标签边界（数组长度）与顺序逐标签识别。

/** 标签等长且逐标签相等：严格按标签边界与顺序，标签内容可含任意字符（含 U+0001） */
export function tagsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i])
}

/**
 * 标签列表的无歧义序列化：JSON 数组形态保留标签边界与顺序，
 * 标签内容可含任意字符（含 U+0001），不同标签列表必得不同字符串。
 */
export function serializeTags(tags: string[]): string {
  return JSON.stringify(tags)
}

/** 标签列表中是否含 U+0001：旧版（U+0001 拼接）签名对这类数据存在歧义，迁移时需重审 */
export function tagsContainSeparator(tags: string[]): boolean {
  return tags.some((t) => t.includes('\u0001'))
}
