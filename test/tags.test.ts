import assert from 'node:assert'
import { serializeTags, tagDisplay, TAG_SEP } from '../src/lib/tags'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// 1. 无分隔符内容保持旧式 join('') 形态（既有签名稳定的前提）
check('不含 U+0001 时沿用旧式拼接（含空数组）', () => {
  assert.strictEqual(serializeTags([]), '')
  assert.strictEqual(serializeTags(['甲']), '甲')
  assert.strictEqual(serializeTags(['甲', '乙']), `甲${TAG_SEP}乙`)
  assert.strictEqual(serializeTags(['A', 'B', 'C']), `A${TAG_SEP}B${TAG_SEP}C`)
})

// 2. 回归：单标签「甲乙」与两个标签「甲」「乙」必须编码不同
check('单标签内含 U+0001 与拆成两个标签编码不同', () => {
  assert.notStrictEqual(
    serializeTags(['甲' + TAG_SEP + '乙']),
    serializeTags(['甲', '乙']),
  )
})

// 3. 边界 / 顺序参与编码
check('标签顺序与空标签参与编码', () => {
  assert.notStrictEqual(serializeTags(['甲', '乙']), serializeTags(['乙', '甲']))
  assert.notStrictEqual(serializeTags(['']), serializeTags([]))
  assert.notStrictEqual(serializeTags(['', '']), serializeTags(['']))
  // 含分隔符标签在不同位置也能区分
  assert.notStrictEqual(
    serializeTags([TAG_SEP, '甲']),
    serializeTags(['甲', TAG_SEP]),
  )
})

// 4. 新形态以 U+0001 开头，旧形态不可能产生该前缀
check('转义形态以分隔符开头且带词条数', () => {
  const s = serializeTags(['甲' + TAG_SEP + '乙'])
  assert.ok(s.startsWith(TAG_SEP))
  // 形态： N  长度  原文
  assert.strictEqual(s, `${TAG_SEP}1${TAG_SEP}3${TAG_SEP}甲${TAG_SEP}乙`)
})

// 5. 新形态不会与某个合法旧形态撞前缀（穷举常见数字开头标签）
check('数字开头的普通标签仍走旧形态，不与转义形态混淆', () => {
  const legacy = serializeTags(['1', '3', 'abc'])
  assert.ok(!legacy.startsWith(TAG_SEP))
  assert.notStrictEqual(legacy, serializeTags([TAG_SEP + '3', 'abc']))
})

// 6. 展示：U+0001 以可见符号渲染，普通标签不变
check('tagDisplay 把 U+0001 显示为 ␁，普通标签原样返回', () => {
  assert.strictEqual(tagDisplay('甲'), '甲')
  assert.strictEqual(tagDisplay('甲' + TAG_SEP + '乙'), '甲␁乙')
})

// 7. 等价输入稳定、不同输入必有差异（小规模穷举）
check('小规模穷举：编码两两不同', () => {
  const inputs: string[][] = [
    [],
    [''],
    ['', ''],
    ['甲'],
    ['甲', '乙'],
    ['乙', '甲'],
    [TAG_SEP],
    [TAG_SEP, TAG_SEP],
    ['甲' + TAG_SEP + '乙'],
    ['甲', '乙' + TAG_SEP],
    ['甲' + TAG_SEP, '乙'],
    [TAG_SEP + '甲' + TAG_SEP, '乙', TAG_SEP],
    ['1', TAG_SEP, 'x'],
  ]
  const encoded = inputs.map(serializeTags)
  assert.strictEqual(new Set(encoded).size, encoded.length)
})

console.log(`\n标签编码：${passed} 项断言全部通过`)
