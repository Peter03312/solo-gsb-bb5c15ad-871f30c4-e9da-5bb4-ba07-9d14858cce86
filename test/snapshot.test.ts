import assert from 'node:assert'
import {
  diffSnapshot,
  diffSignature,
  makeBaseline,
  migrateReviewedDiffs,
  normalizeBaseline,
  normalizeReviewedDiffs,
  pruneReviewedDiffs,
  rangeLabel,
  reviewedKey,
  snapshotAnnotation,
} from '../src/lib/snapshot'
import { serializeTags, tagsEqual } from '../src/lib/tags'
import type { Annotation, BaselineAnnotation } from '../src/types'
import { hash53, legacySerializeSnapshot } from './legacySig'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

let seq = 0
function ann(
  start: number,
  end: number,
  tags: string[] = [],
  id?: string,
  opts: Partial<Annotation> = {},
): Annotation {
  seq += 1
  return {
    id: id ?? `a${seq}`,
    quote: '',
    start,
    end,
    note: '',
    tags,
    status: 'bound',
    createdAt: 0,
    updatedAt: 0,
    contextBefore: '',
    contextAfter: '',
    ...opts,
  }
}

function baseOf(a: Annotation): BaselineAnnotation {
  return snapshotAnnotation(a)
}

// 1. 无基线 → 无差异
check('基线为 null 时不产生差异', () => {
  assert.deepStrictEqual(diffSnapshot(null, [ann(0, 5)]), [])
})

// 2. 基线与当前一致 → 无差异
check('基线与当前一致时没有差异', () => {
  const a = ann(0, 5, ['X'], 'a1', { quote: '甲乙丙', note: '备注' })
  const baseline = makeBaseline([a])
  assert.deepStrictEqual(diffSnapshot(baseline, [a]), [])
})

// 3. 新增：仅当前存在
check('仅当前存在的标注归为新增', () => {
  const a = ann(0, 5, ['X'], 'a1', { quote: '甲乙' })
  const baseline = makeBaseline([])
  const diffs = diffSnapshot(baseline, [a])
  assert.strictEqual(diffs.length, 1)
  assert.strictEqual(diffs[0].kind, 'added')
  assert.strictEqual(diffs[0].annotationId, 'a1')
  assert.strictEqual(diffs[0].base, null)
  assert.strictEqual(diffs[0].current?.id, 'a1')
  assert.deepStrictEqual(diffs[0].changes, [])
})

// 4. 删除：仅基线存在，保留基线引文
check('仅基线存在的标注归为删除，并保留基线引文', () => {
  const a = ann(3, 8, ['Y'], 'a1', { quote: '被删引文', note: '旧备注' })
  const baseline = makeBaseline([a])
  const diffs = diffSnapshot(baseline, [])
  assert.strictEqual(diffs.length, 1)
  assert.strictEqual(diffs[0].kind, 'removed')
  assert.strictEqual(diffs[0].current, null)
  assert.strictEqual(diffs[0].base?.quote, '被删引文')
  assert.strictEqual(diffs[0].base?.note, '旧备注')
  assert.deepStrictEqual(diffs[0].base?.tags, ['Y'])
})

// 5. 修改：同一标注无论变几个字段都只产生一项，且逐字段列出前后值
check('修改项逐字段列出前后值，同一标注只生成一项', () => {
  const before = ann(2, 6, ['甲'], 'a1', { quote: '旧引文', note: '旧备注' })
  const baseline = makeBaseline([before])
  const after: Annotation = {
    ...before,
    start: 3,
    end: 9,
    quote: '新引文',
    note: '新备注',
    tags: ['乙', '丙'],
  }
  const diffs = diffSnapshot(baseline, [after])
  assert.strictEqual(diffs.length, 1)
  const d = diffs[0]
  assert.strictEqual(d.kind, 'modified')
  const fields = d.changes.map((c) => c.field)
  assert.deepStrictEqual(fields, ['range', 'quote', 'tags', 'note'])
  const byField = Object.fromEntries(d.changes.map((c) => [c.field, c]))
  assert.strictEqual(byField.range.before, '已绑定 [2, 6)')
  assert.strictEqual(byField.range.after, '已绑定 [3, 9)')
  assert.strictEqual(byField.quote.before, '旧引文')
  assert.strictEqual(byField.quote.after, '新引文')
  assert.strictEqual(byField.tags.before, '#甲')
  assert.strictEqual(byField.tags.after, '#乙 #丙')
  assert.strictEqual(byField.note.before, '旧备注')
  assert.strictEqual(byField.note.after, '新备注')
})

// 6. 绑定状态变化：bound → pending 归入区间/绑定字段
check('绑定状态变化列入区间/绑定字段', () => {
  const before = ann(2, 6, [], 'a1')
  const baseline = makeBaseline([before])
  const after: Annotation = { ...before, status: 'pending' }
  const diffs = diffSnapshot(baseline, [after])
  assert.strictEqual(diffs.length, 1)
  assert.strictEqual(diffs[0].changes.length, 1)
  assert.strictEqual(diffs[0].changes[0].field, 'range')
  assert.strictEqual(diffs[0].changes[0].after, rangeLabel('pending', 2, 6))
})

// 7. 标签顺序变化也算修改
check('标签顺序变化视为修改', () => {
  const before = ann(0, 4, ['A', 'B'], 'a1')
  const baseline = makeBaseline([before])
  const after: Annotation = { ...before, tags: ['B', 'A'] }
  const diffs = diffSnapshot(baseline, [after])
  assert.strictEqual(diffs.length, 1)
  assert.strictEqual(diffs[0].changes[0].field, 'tags')
})

// 8. 排序：按原文位置（当前已绑定取当前区间，删除项取基线区间）
check('差异项按原文位置排序', () => {
  const removed = ann(1, 3, [], 'r1', { quote: '删' })
  const kept = ann(10, 12, [], 'k1')
  const baseline = makeBaseline([removed, kept])
  const added = ann(5, 7, [], 'n1', { quote: '增' })
  const modified: Annotation = { ...kept, note: '改了' }
  const diffs = diffSnapshot(baseline, [modified, added])
  assert.deepStrictEqual(
    diffs.map((d) => [d.kind, d.annotationId]),
    [
      ['removed', 'r1'], // 基线位置 1
      ['added', 'n1'], // 当前位置 5
      ['modified', 'k1'], // 当前位置 10
    ],
  )
})

// 9. 签名稳定：同样的差异内容 → 同样的签名与键
check('相同差异内容产生相同签名', () => {
  const before = ann(0, 4, ['X'], 'a1', { note: '一' })
  const baseline = makeBaseline([before])
  const after: Annotation = { ...before, note: '二' }
  const d1 = diffSnapshot(baseline, [after])
  const d2 = diffSnapshot(makeBaseline([before]), [{ ...after }])
  assert.strictEqual(d1[0].signature, d2[0].signature)
  assert.strictEqual(d1[0].key, reviewedKey('a1', d1[0].signature))
})

// 10. 内容再次变化 → 新签名；恢复成基线 → 差异消失
check('内容再次变化签名改变，恢复成基线差异消失', () => {
  const before = ann(0, 4, [], 'a1', { note: '原始' })
  const baseline = makeBaseline([before])
  const v1 = diffSnapshot(baseline, [{ ...before, note: '改一' }])
  const v2 = diffSnapshot(baseline, [{ ...before, note: '改二' }])
  assert.strictEqual(v1.length, 1)
  assert.strictEqual(v2.length, 1)
  assert.notStrictEqual(v1[0].signature, v2[0].signature)
  // 恢复成基线
  assert.deepStrictEqual(diffSnapshot(baseline, [before]), [])
})

// 11. 新增项内容变化同样改变签名
check('新增项内容变化后签名改变', () => {
  const baseline = makeBaseline([])
  const a = ann(0, 4, [], 'n1', { note: '一' })
  const s1 = diffSnapshot(baseline, [a])[0].signature
  const s2 = diffSnapshot(baseline, [{ ...a, note: '二' }])[0].signature
  assert.notStrictEqual(s1, s2)
})

// 12. diffSignature 三种类型互不冲突
check('不同类型差异的签名互不相同', () => {
  const a = ann(0, 4, [], 'x', { quote: 'q' })
  const b = baseOf(a)
  const sAdded = diffSignature('added', null, a)
  const sRemoved = diffSignature('removed', b, null)
  const sModified = diffSignature('modified', b, { ...a, note: 'n' })
  assert.notStrictEqual(sAdded, sRemoved)
  assert.notStrictEqual(sAdded, sModified)
  assert.notStrictEqual(sRemoved, sModified)
})

// 13. pruneReviewedDiffs：仅保留命中当前差异的记录
check('已审记录按当前差异签名清理', () => {
  const before = ann(0, 4, [], 'a1')
  const baseline = makeBaseline([before])
  const diffs = diffSnapshot(baseline, [{ ...before, note: '新' }])
  const valid = { annotationId: 'a1', signature: diffs[0].signature, createdAt: 1 }
  const stale = { annotationId: 'a1', signature: 'old-sig', createdAt: 2 }
  const gone = { annotationId: 'ghost', signature: 'x', createdAt: 3 }
  const pruned = pruneReviewedDiffs([valid, stale, gone], diffs)
  assert.deepStrictEqual(pruned, [valid])
})

// 14. makeBaseline 深拷贝：之后的标注修改不影响基线快照
check('基线快照与当前标注互不影响', () => {
  const a = ann(0, 4, ['X'], 'a1', { note: '旧' })
  const baseline = makeBaseline([a])
  a.tags.push('Y')
  a.note = '新'
  assert.deepStrictEqual(baseline.annotations[0].tags, ['X'])
  assert.strictEqual(baseline.annotations[0].note, '旧')
})

// 15. normalizeBaseline：非法输入 → null；缺字段补默认；重复 ID 去重
check('normalizeBaseline 兼容旧数据与脏数据', () => {
  assert.strictEqual(normalizeBaseline(undefined), null)
  assert.strictEqual(normalizeBaseline(null), null)
  assert.strictEqual(normalizeBaseline({}), null)
  assert.strictEqual(normalizeBaseline({ annotations: 'x' }), null)
  const b = normalizeBaseline({
    createdAt: '2026-09-18T00:00:00.000Z',
    annotations: [
      { id: 'a1', status: 'pending', quote: 'q', note: 'n', tags: ['T'], start: 1, end: 2 },
      { id: 'a1', status: 'bound', quote: 'dup' }, // 重复 ID 丢弃
      { id: '', quote: 'no-id' }, // 无 ID 丢弃
      { id: 'a2' }, // 缺字段补默认
      'junk',
    ],
  })
  assert.ok(b)
  assert.strictEqual(b!.annotations.length, 2)
  assert.strictEqual(b!.annotations[0].status, 'pending')
  assert.strictEqual(b!.annotations[1].quote, '')
  assert.deepStrictEqual(b!.annotations[1].tags, [])
  assert.strictEqual(b!.annotations[1].start, 0)
  assert.ok(b!.createdAt > 0)
})

// 16. normalizeReviewedDiffs：非数组 → 空；缺字段丢弃；同键去重；ISO 时间可解析
check('normalizeReviewedDiffs 兼容旧数据与脏数据', () => {
  assert.deepStrictEqual(normalizeReviewedDiffs(undefined), [])
  assert.deepStrictEqual(normalizeReviewedDiffs('x'), [])
  const out = normalizeReviewedDiffs([
    { annotationId: 'a1', signature: 's1', createdAt: '2026-09-18T00:00:00.000Z' },
    { annotationId: 'a1', signature: 's1' }, // 同键去重
    { annotationId: '', signature: 's2' }, // 缺 ID 丢弃
    { annotationId: 'a2' }, // 缺签名丢弃
    { annotationId: 'a3', signature: 's3', createdAt: 123 },
  ])
  assert.strictEqual(out.length, 2)
  assert.strictEqual(out[0].annotationId, 'a1')
  assert.ok(out[0].createdAt > 0)
  assert.strictEqual(out[1].createdAt, 123)
})

// 17. 空引文 / 空备注的展示占位
check('空内容以前后值占位符展示', () => {
  const before = ann(0, 4, [], 'a1', { quote: '', note: '' })
  const baseline = makeBaseline([before])
  const after: Annotation = { ...before, quote: '新增引文', note: '新增备注' }
  const diffs = diffSnapshot(baseline, [after])
  const byField = Object.fromEntries(diffs[0].changes.map((c) => [c.field, c]))
  assert.strictEqual(byField.quote.before, '（空）')
  assert.strictEqual(byField.note.before, '（空）')
})

// 18. 回归：标签内容允许含 U+0001，单标签「甲\u0001乙」拆成「甲」「乙」必须识别为标签变化
check('单标签含 U+0001 拆成两个标签时识别为修改并展示标签差异', () => {
  const SOH = String.fromCharCode(1)
  const before = ann(0, 4, [`甲${SOH}乙`], 'a1')
  const baseline = makeBaseline([before])
  const after: Annotation = { ...before, tags: ['甲', '乙'] }
  const diffs = diffSnapshot(baseline, [after])
  assert.strictEqual(diffs.length, 1)
  assert.strictEqual(diffs[0].kind, 'modified')
  assert.deepStrictEqual(diffs[0].changes.map((c) => c.field), ['tags'])
  // 控制字符在展示中转义，两种标签形态肉眼可区分
  assert.strictEqual(diffs[0].changes[0].before, '#甲\\u0001乙')
  assert.strictEqual(diffs[0].changes[0].after, '#甲 #乙')
})

// 19. 回归：现行签名区分「单标签含 U+0001」与「两个标签」（旧版二者相同）
check('现行差异签名区分含 U+0001 的单标签与两个标签', () => {
  const SOH = String.fromCharCode(1)
  const before = ann(0, 4, [`甲${SOH}乙`], 'a1')
  const baseline = makeBaseline([before])
  const split: Annotation = { ...before, tags: ['甲', '乙'] }
  const splitSig = diffSnapshot(baseline, [split])[0].signature
  // 旧版规则下两种形态签名相同（缺陷复现）
  const unchangedLegacy = `M|${legacySerializeSnapshot(baseline.annotations[0])}|${legacySerializeSnapshot({ ...snapshotAnnotation(split), tags: [`甲${SOH}乙`] })}`
  const splitLegacy = `M|${legacySerializeSnapshot(baseline.annotations[0])}|${legacySerializeSnapshot(snapshotAnnotation(split))}`
  assert.strictEqual(hash53(unchangedLegacy), hash53(splitLegacy))
  // 现行签名不再相等
  const unchangedSig = diffSignature('modified', baseline.annotations[0], before)
  assert.notStrictEqual(splitSig, unchangedSig)
})

// 20. tagsEqual / serializeTags 按边界与顺序识别
check('标签比较与序列化按标签边界与顺序识别（标签可含 U+0001）', () => {
  const SOH = String.fromCharCode(1)
  assert.ok(tagsEqual(['甲', '乙'], ['甲', '乙']))
  assert.ok(!tagsEqual([`甲${SOH}乙`], ['甲', '乙']))
  assert.ok(!tagsEqual(['甲', '乙'], ['乙', '甲']))
  assert.ok(!tagsEqual(['甲'], ['甲', '乙']))
  assert.notStrictEqual(serializeTags([`甲${SOH}乙`]), serializeTags(['甲', '乙']))
  assert.notStrictEqual(serializeTags(['甲', '乙']), serializeTags(['乙', '甲']))
  assert.strictEqual(serializeTags(['甲', '乙']), serializeTags(['甲', '乙']))
})

// 21. 回归迁移：旧版已审记录，标签内容未变（不含 U+0001）→ 改写为现行签名，结论保留
check('migrateReviewedDiffs 保留标签未变的旧版已审结论', () => {
  const before = ann(0, 4, ['甲'], 'a1', { note: '旧' })
  const baseline = makeBaseline([before])
  const after: Annotation = { ...before, note: '新' }
  const items = diffSnapshot(baseline, [after])
  // 用旧版规则算出当时落库的签名
  const legacySig = hash53(
    `M|${legacySerializeSnapshot(baseline.annotations[0])}|${legacySerializeSnapshot(snapshotAnnotation(after))}`,
  )
  const old = { annotationId: 'a1', signature: legacySig, createdAt: 1 }
  const out = migrateReviewedDiffs([old], items)
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].signature, items[0].signature)
  assert.strictEqual(out[0].createdAt, 1)
  // 幂等：再次迁移结果不变
  assert.deepStrictEqual(migrateReviewedDiffs(out, items), out)
})

// 22. 回归迁移：旧版已审记录但标签确已拆分（含 U+0001）→ 不迁移，恢复未审
check('migrateReviewedDiffs 对含 U+0001 的标签拆分差异恢复未审', () => {
  const SOH = String.fromCharCode(1)
  const before = ann(0, 4, [`甲${SOH}乙`], 'a1')
  const baseline = makeBaseline([before])
  const after: Annotation = { ...before, tags: ['甲', '乙'] }
  const items = diffSnapshot(baseline, [after])
  // 旧版下「拆分」不产生差异、也无签名；模拟的是更一般的情形：
  // 旧版记录的签名等于按旧规则重算值，但标签含 U+0001，无法确认边界 → 丢弃
  const legacySig = hash53(
    `M|${legacySerializeSnapshot(baseline.annotations[0])}|${legacySerializeSnapshot(snapshotAnnotation(after))}`,
  )
  const old = { annotationId: 'a1', signature: legacySig, createdAt: 1 }
  assert.deepStrictEqual(migrateReviewedDiffs([old], items), [])
  // 现行签名的已审记录不受影响，正常保留
  const current = { annotationId: 'a1', signature: items[0].signature, createdAt: 2 }
  assert.deepStrictEqual(migrateReviewedDiffs([current], items), [current])
})

// 23. 迁移不复活已失效记录：标注已恢复成基线（无差异项）→ 旧记录被清理
check('migrateReviewedDiffs 清理已无对应差异项的旧记录', () => {
  const a = ann(0, 4, ['甲'], 'a1', { note: 'n' })
  const baseline = makeBaseline([a])
  const old = { annotationId: 'a1', signature: 'whatever', createdAt: 1 }
  assert.deepStrictEqual(migrateReviewedDiffs([old], diffSnapshot(baseline, [a])), [])
})

console.log(`\nsnapshot：${passed} 项断言全部通过`)
