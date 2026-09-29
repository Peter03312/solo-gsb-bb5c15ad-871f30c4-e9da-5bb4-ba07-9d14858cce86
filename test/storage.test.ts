import assert from 'node:assert'
import { JSDOM } from 'jsdom'
import type { Annotation, DocumentData } from '../src/types'
import { loadDocument, saveDocument, STORAGE_KEY } from '../src/lib/storage'
import { annotationContentSignature } from '../src/lib/sampling'
import { diffSnapshot } from '../src/lib/snapshot'
import { hash53, legacyContentSignature, legacySerializeSnapshot } from './legacySig'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
;(globalThis as unknown as { localStorage: Storage }).localStorage = dom.window.localStorage
;(globalThis as unknown as { window: unknown }).window = dom.window

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

function ann(tags: string[], note = '', id = 'a1'): Annotation {
  return {
    id,
    quote: '零一',
    start: 0,
    end: 2,
    note,
    tags,
    status: 'bound',
    createdAt: 1,
    updatedAt: 1,
    contextBefore: '',
    contextAfter: '',
  }
}

function makeDoc(): DocumentData {
  return {
    title: '本地保存兼容',
    text: '零一二三四五六七八九',
    annotations: [],
    conflictRules: [],
    ignoredConflicts: [],
    coverageTags: [],
    baseline: null,
    reviewedDiffs: [],
    sampleConfig: null,
    sampleReviews: [],
    relations: [],
    relationCardinalityRules: [],
    updatedAt: 1,
  }
}

// 1. 旧版本地数据：不含 U+0001 的已审记录 / 复核结论，加载后迁移并仍有效
check('本地保存旧版数据：常规标签的旧签名迁移后结论保留', () => {
  const current = ann(['甲'], '新备注')
  const baselineSnap = {
    id: 'a1',
    status: 'bound' as const,
    quote: '零一',
    note: '',
    tags: ['甲'],
    start: 0,
    end: 2,
  }
  const currentSnap = { ...baselineSnap, note: '新备注' }
  const doc: DocumentData = {
    ...makeDoc(),
    annotations: [current],
    baseline: { createdAt: 2, annotations: [baselineSnap] },
    reviewedDiffs: [
      {
        annotationId: 'a1',
        signature: hash53(
          `M|${legacySerializeSnapshot(baselineSnap)}|${legacySerializeSnapshot(currentSnap)}`,
        ),
        createdAt: 3,
      },
    ],
    sampleReviews: [
      {
        annotationId: 'a1',
        signature: legacyContentSignature(currentSnap),
        verdict: 'pass',
        note: '',
        createdAt: 3,
        updatedAt: 3,
      },
    ],
  }
  dom.window.localStorage.setItem(STORAGE_KEY, JSON.stringify(doc))
  const loaded = loadDocument()
  assert.ok(loaded)
  const items = diffSnapshot(loaded!.baseline, loaded!.annotations)
  assert.strictEqual(items.length, 1)
  assert.strictEqual(loaded!.reviewedDiffs.length, 1)
  assert.strictEqual(loaded!.reviewedDiffs[0].signature, items[0].signature)
  assert.strictEqual(loaded!.sampleReviews.length, 1)
  assert.strictEqual(
    loaded!.sampleReviews[0].signature,
    annotationContentSignature(loaded!.annotations[0]),
  )

  // 迁移后的数据再次本地保存、再次加载，结果稳定（幂等，不再被误清）
  saveDocument(loaded!)
  const reloaded = loadDocument()
  assert.deepStrictEqual(reloaded!.reviewedDiffs, loaded!.reviewedDiffs)
  assert.deepStrictEqual(reloaded!.sampleReviews, loaded!.sampleReviews)
})

// 2. 现行版本保存 → 加载：数据原样可用
check('现行版本保存后加载：数据无损', () => {
  const current = ann(['甲', '乙'], '备注')
  const doc = makeDoc()
  doc.annotations = [current]
  doc.sampleReviews = [
    {
      annotationId: 'a1',
      signature: annotationContentSignature(current),
      verdict: 'return',
      note: '退回原因',
      createdAt: 4,
      updatedAt: 4,
    },
  ]
  saveDocument(doc)
  const loaded = loadDocument()
  assert.ok(loaded)
  assert.deepStrictEqual(loaded!.annotations[0].tags, ['甲', '乙'])
  assert.strictEqual(loaded!.sampleReviews.length, 1)
  assert.strictEqual(loaded!.sampleReviews[0].verdict, 'return')
  assert.strictEqual(loaded!.sampleReviews[0].note, '退回原因')
})

// 3. 含 U+0001 的标签本身可以本地保存并原样读回（标签允许包含该字符）
check('标签内含 U+0001 时本地保存 / 加载后标签内容不变', () => {
  const SOH = String.fromCharCode(1)
  const doc = makeDoc()
  doc.annotations = [ann([`甲${SOH}乙`, '丙'])]
  saveDocument(doc)
  const loaded = loadDocument()
  assert.ok(loaded)
  assert.deepStrictEqual(loaded!.annotations[0].tags, [`甲${SOH}乙`, '丙'])
})

console.log(`\n本地存储：${passed} 项断言全部通过`)
