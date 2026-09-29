// 模拟修复前（旧版）的签名算法，用于构造「旧版持久化数据」验证迁移逻辑。
// 旧版缺陷：标签用 U+0001 拼接，标签本身允许含 U+0001，
// 因此 ['甲\u0001乙'] 与 ['甲','乙'] 会得到相同签名。

import type { Annotation, BaselineAnnotation } from '../src/types'

/** cyrb53：与 src/lib/snapshot.ts、src/lib/sampling.ts 中相同的确定性散列 */
export function hash53(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)
}

const SOH = String.fromCharCode(1)
const NUL = String.fromCharCode(0)

type Content = Pick<Annotation, 'status' | 'start' | 'end' | 'quote' | 'tags' | 'note'>

/** 旧版标注内容序列化（抽样复核签名输入） */
export function legacySerializeContent(a: Content): string {
  return [a.status, a.start, a.end, a.quote, a.tags.join(SOH), a.note].join(NUL)
}

/** 旧版抽样复核内容签名 */
export function legacyContentSignature(a: Content): string {
  return hash53(legacySerializeContent(a))
}

/** 旧版基线快照序列化 */
export function legacySerializeSnapshot(s: BaselineAnnotation): string {
  return [s.status, s.start, s.end, s.quote, s.tags.join(SOH), s.note].join(NUL)
}
