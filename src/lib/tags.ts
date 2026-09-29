// 标签序列的规范化比较
//
// 标签内容允许包含任意字符，包括 U+0001（SOX）。早期实现直接 tags.join(U+0001)：
// 单标签「甲乙」与两个标签「甲」「乙」拼出同一字符串，导致快照对比漏报、
// 抽样复核沿用旧内容签名。这里提供保序、按词条边界编码的规范化序列化：
//
//   - 所有词条均非空且不含 U+0001 时，沿用旧式 tags.join(U+0001)（空数组为空串），
//     使既有数据（不含该分隔符）的快照签名 / 复核签名逐条不变；
//   - 否则使用长度前缀形态：
//       U+0001 + 词条数 + U+0001 + (词条长度 + U+0001 + 词条原文) * N
//     起始 U+0001 是旧形态不可能产生的标记（旧形态首字符必为非空标签首字符），
//     每个词条按定长读取，词条内容中的 U+0001 不再造成边界歧义。

/** 标签分隔符（SOX）：历史签名即以此字符连接标签 */
export const TAG_SEP = ''

/**
 * 标签序列的规范化序列化：同一标签数组必得同一字符串，
 * 标签边界 / 顺序 / 内容任一不同必得不同字符串。供比较与签名共用。
 */
export function serializeTags(tags: readonly string[]): string {
  const needsEscape = tags.some((t) => t === '' || t.includes(TAG_SEP))
  if (!needsEscape) return tags.join(TAG_SEP)
  let out = `${TAG_SEP}${tags.length}${TAG_SEP}`
  for (const t of tags) out += `${t.length}${TAG_SEP}${t}`
  return out
}

/** 展示用：把标签中不可见的 U+0001 替换为可见符号（␁），仅用于界面渲染 */
export function tagDisplay(tag: string): string {
  return tag.includes(TAG_SEP) ? tag.split(TAG_SEP).join('␁') : tag
}
