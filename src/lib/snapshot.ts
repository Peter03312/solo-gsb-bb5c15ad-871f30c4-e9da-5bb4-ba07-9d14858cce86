// 标注快照对比：唯一基线、差异计算与已审签名
//
// 用户可把当前标注集保存为唯一基线，之后随时与当前数据对比。
// 按稳定标注 ID 对齐两侧：
//   - 仅当前存在 → 新增；
//   - 仅基线存在 → 删除；
//   - 两侧都存在但内容不同 → 修改（逐字段列出前后值，同一标注只产生一项）。
// 每个差异项带有「差异内容签名」：
//   - 内容再次变化 → 签名改变，已审记录不再命中，该项重新出现为未审；
//   - 恢复成基线 → 差异项消失，对应已审记录被清理；
//   - 重建基线 → 全部已审记录清空（由调用方处理）。
//
// 标签允许包含 U+0001，因此标签比较不能用 U+0001 拼接字符串
// （['甲\x01乙'] 与 ['甲', '乙'] 会拼成同一串），签名序列化同理。
// 现行实现逐标签按边界与顺序比较，标签列表以 JSON 序列化进签名；
// 旧版（U+0001 拼接）签名由 migrateReviewedDiffs 在加载 / 导入时一次性迁移。

import type {
  Annotation,
  AnnotationBaseline,
  AnnotationStatus,
  BaselineAnnotation,
  ReviewedDiff,
} from '../types'
import { serializeTags, tagsContainSeparator, tagsEqual } from './tags'

/** 差异类型：新增 / 删除 / 修改 */
export type SnapshotDiffKind = 'added' | 'removed' | 'modified'

export const DIFF_KIND_LABEL: Record<SnapshotDiffKind, string> = {
  added: '新增',
  removed: '删除',
  modified: '修改',
}

/** 参与对比的字段：区间/绑定状态、引文、标签、备注 */
export type SnapshotField = 'range' | 'quote' | 'tags' | 'note'

export interface SnapshotFieldChange {
  field: SnapshotField
  label: string
  /** 展示用前后值（空内容以占位符显示） */
  before: string
  after: string
}

export interface SnapshotDiffItem {
  /** 标注 ID + 差异内容签名，作为已审记录与渲染的稳定键 */
  key: string
  annotationId: string
  kind: SnapshotDiffKind
  signature: string
  /** 基线快照（新增项为 null） */
  base: BaselineAnnotation | null
  /** 当前标注（删除项为 null） */
  current: Annotation | null
  /** 修改项的逐字段前后值（新增 / 删除为空数组） */
  changes: SnapshotFieldChange[]
  /** 排序用原文位置：当前已绑定取当前区间，否则取基线区间 */
  sortStart: number
  sortEnd: number
}

/** 已审记录的键：标注 ID + 差异内容签名 */
export function reviewedKey(annotationId: string, signature: string): string {
  return `${annotationId}\u0000${signature}`
}

/** 把一条当前标注拍成基线快照（深拷贝标签，之后互不影响） */
export function snapshotAnnotation(a: Annotation): BaselineAnnotation {
  return {
    id: a.id,
    status: a.status,
    quote: a.quote,
    note: a.note,
    tags: [...a.tags],
    start: a.start,
    end: a.end,
  }
}

/** 以当前标注集建立唯一基线 */
export function makeBaseline(annotations: Annotation[]): AnnotationBaseline {
  return {
    createdAt: Date.now(),
    annotations: annotations.map(snapshotAnnotation),
  }
}

/** 区间 / 绑定状态的展示文案 */
export function rangeLabel(
  status: AnnotationStatus,
  start: number,
  end: number,
): string {
  return status === 'bound' ? `已绑定 [${start}, ${end})` : '待处理（未绑定区间）'
}

function displayValue(s: string): string {
  return s === '' ? '（空）' : s
}

/** 标签展示用的控制字符转义（U+0000–U+001F），避免标签内分隔符在界面上不可见 */
function escapeTagControl(t: string): string {
  return t.replace(/[\x00-\x1f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function tagsLabel(tags: string[]): string {
  return tags.length > 0
    ? tags.map((t) => `#${escapeTagControl(t)}`).join(' ')
    : '（无标签）'
}

/** 逐字段对比基线快照与当前标注，返回全部变化字段的前后值 */
function fieldChanges(
  base: BaselineAnnotation,
  cur: Annotation,
): SnapshotFieldChange[] {
  const changes: SnapshotFieldChange[] = []
  if (base.status !== cur.status || base.start !== cur.start || base.end !== cur.end) {
    changes.push({
      field: 'range',
      label: '区间/绑定',
      before: rangeLabel(base.status, base.start, base.end),
      after: rangeLabel(cur.status, cur.start, cur.end),
    })
  }
  if (base.quote !== cur.quote) {
    changes.push({
      field: 'quote',
      label: '引文',
      before: displayValue(base.quote),
      after: displayValue(cur.quote),
    })
  }
  if (!tagsEqual(base.tags, cur.tags)) {
    changes.push({
      field: 'tags',
      label: '标签',
      before: tagsLabel(base.tags),
      after: tagsLabel(cur.tags),
    })
  }
  if (base.note !== cur.note) {
    changes.push({
      field: 'note',
      label: '备注',
      before: displayValue(base.note),
      after: displayValue(cur.note),
    })
  }
  return changes
}

/** 快照内容的稳定序列化（签名输入，含全部参与对比的字段） */
function serializeSnapshot(s: BaselineAnnotation): string {
  return [s.status, s.start, s.end, s.quote, serializeTags(s.tags), s.note].join('\u0000')
}

/**
 * 旧版序列化（仅迁移用）：标签以 U+0001 拼接。
 * 标签内含 U+0001 时存在歧义（['甲\u0001乙']（标签内含一个 U+0001 字符）与 ['甲','乙']
 * 的旧版拼接结果相同），故仅在两侧标签均不含 U+0001 时才可凭旧签名确认「内容未变」。
 */
function legacySerializeSnapshot(s: BaselineAnnotation): string {
  return [s.status, s.start, s.end, s.quote, s.tags.join('\u0001'), s.note].join('\u0000')
}

/** 按旧版规则重算差异签名（迁移核对用） */
function legacyDiffSignature(item: SnapshotDiffItem): string {
  const payload =
    item.kind === 'added'
      ? `A|${legacySerializeSnapshot(snapshotAnnotation(item.current!))}`
      : item.kind === 'removed'
        ? `R|${legacySerializeSnapshot(item.base!)}`
        : `M|${legacySerializeSnapshot(item.base!)}|${legacySerializeSnapshot(snapshotAnnotation(item.current!))}`
  return hash53(payload)
}

/** cyrb53：确定性的 53 位字符串散列（同一内容跨会话签名一致） */
function hash53(str: string): string {
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

/**
 * 差异内容签名：
 * - 新增 / 删除：当前（或基线）快照全量内容；
 * - 修改：基线快照 + 当前快照，任一侧内容变化都会得到新签名。
 */
export function diffSignature(
  kind: SnapshotDiffKind,
  base: BaselineAnnotation | null,
  current: Annotation | null,
): string {
  const payload =
    kind === 'added'
      ? `A|${serializeSnapshot(snapshotAnnotation(current!))}`
      : kind === 'removed'
        ? `R|${serializeSnapshot(base!)}`
        : `M|${serializeSnapshot(base!)}|${serializeSnapshot(snapshotAnnotation(current!))}`
  return hash53(payload)
}

function sortRangeOf(
  base: BaselineAnnotation | null,
  current: Annotation | null,
): { start: number; end: number } {
  if (current && current.status === 'bound') {
    return { start: current.start, end: current.end }
  }
  if (base) return { start: base.start, end: base.end }
  if (current) return { start: current.start, end: current.end }
  return { start: 0, end: 0 }
}

/**
 * 计算基线与当前标注集的全部差异。
 * 纯函数：不修改传入数据；baseline 为 null 时返回空数组。
 * 结果按原文位置排序（起点、终点、再按标注 ID）。
 */
export function diffSnapshot(
  baseline: AnnotationBaseline | null,
  annotations: Annotation[],
): SnapshotDiffItem[] {
  if (!baseline) return []
  const baseById = new Map(baseline.annotations.map((b) => [b.id, b]))
  const curById = new Map(annotations.map((a) => [a.id, a]))
  const items: SnapshotDiffItem[] = []

  const push = (
    kind: SnapshotDiffKind,
    annotationId: string,
    base: BaselineAnnotation | null,
    current: Annotation | null,
    changes: SnapshotFieldChange[],
  ) => {
    const signature = diffSignature(kind, base, current)
    const range = sortRangeOf(base, current)
    items.push({
      key: reviewedKey(annotationId, signature),
      annotationId,
      kind,
      signature,
      base,
      current,
      changes,
      sortStart: range.start,
      sortEnd: range.end,
    })
  }

  for (const b of baseline.annotations) {
    const cur = curById.get(b.id)
    if (!cur) {
      push('removed', b.id, b, null, [])
      continue
    }
    const changes = fieldChanges(b, cur)
    // 同一标注无论变了几个字段都只产生一个修改项
    if (changes.length > 0) push('modified', b.id, b, cur, changes)
  }
  for (const a of annotations) {
    if (!baseById.has(a.id)) push('added', a.id, null, a, [])
  }

  items.sort(
    (x, y) =>
      x.sortStart - y.sortStart ||
      x.sortEnd - y.sortEnd ||
      x.annotationId.localeCompare(y.annotationId),
  )
  return items
}

/**
 * 清理已审记录：仅保留仍能命中当前差异项（标注 ID + 签名完全一致）的记录。
 * 差异内容再次变化或恢复成基线后，对应记录在此被移除。
 */
export function pruneReviewedDiffs(
  reviewed: ReviewedDiff[],
  items: SnapshotDiffItem[],
): ReviewedDiff[] {
  const valid = new Set(items.map((i) => i.key))
  return reviewed.filter((r) => valid.has(reviewedKey(r.annotationId, r.signature)))
}

/**
 * 旧版已审记录迁移：旧签名把标签用 U+0001 拼接，标签内含 U+0001 时会漏判标签变化。
 * 对每条已审记录，按其标注 ID 找到当前差异项并用旧版规则重算旧签名：
 *   - 记录签名与重算的旧签名一致、且差异两侧标签均不含 U+0001（无歧义）
 *     → 内容确未变化，把签名改写为现行签名，已审结论保留；
 *   - 差异两侧任一标签含 U+0001（旧签名无法区分「单标签含 U+0001」与「多个标签」）
 *     或签名对不上 → 原样保留，交由 pruneReviewedDiffs 清理，该项恢复未审。
 * 因此「不含 U+0001 的已审记录」一律平滑保留；缺陷所涉的含分隔符数据重新送审。
 * 已是现行签名的记录直接通过最后的 prune 保留。幂等：再次调用结果不变。
 */
export function migrateReviewedDiffs(
  reviewed: ReviewedDiff[],
  items: SnapshotDiffItem[],
): ReviewedDiff[] {
  const byAnnotationId = new Map(items.map((i) => [i.annotationId, i]))
  const migrated = reviewed.map((r) => {
    const item = byAnnotationId.get(r.annotationId)
    if (!item || r.signature === item.signature) return r
    const tagsAmbiguous =
      (item.base ? tagsContainSeparator(item.base.tags) : false) ||
      (item.current ? tagsContainSeparator(item.current.tags) : false)
    if (tagsAmbiguous) return r
    if (r.signature !== legacyDiffSignature(item)) return r
    return { ...r, signature: item.signature }
  })
  return pruneReviewedDiffs(migrated, items)
}

function parseTime(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return t
  }
  return Date.now()
}

/** 清洗基线数据：非法输入按 null 处理（旧版数据缺省即 null）；重复标注 ID 保留第一条 */
export function normalizeBaseline(raw: unknown): AnnotationBaseline | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<AnnotationBaseline>
  if (!Array.isArray(r.annotations)) return null
  const seen = new Set<string>()
  const annotations: BaselineAnnotation[] = []
  for (const x of r.annotations) {
    if (!x || typeof x !== 'object') continue
    const b = x as Partial<BaselineAnnotation>
    const id = typeof b.id === 'string' ? b.id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    annotations.push({
      id,
      status: b.status === 'pending' ? 'pending' : 'bound',
      quote: typeof b.quote === 'string' ? b.quote : '',
      note: typeof b.note === 'string' ? b.note : '',
      tags: Array.isArray(b.tags) ? b.tags.map(String).filter(Boolean) : [],
      start: typeof b.start === 'number' && Number.isFinite(b.start) ? b.start : 0,
      end: typeof b.end === 'number' && Number.isFinite(b.end) ? b.end : 0,
    })
  }
  return { createdAt: parseTime(r.createdAt), annotations }
}

/** 清洗已审记录：非数组按空处理；缺标注 ID 或签名的条目丢弃；同键去重保留首条 */
export function normalizeReviewedDiffs(raw: unknown): ReviewedDiff[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: ReviewedDiff[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const r = x as Partial<ReviewedDiff>
    const annotationId = typeof r.annotationId === 'string' ? r.annotationId : ''
    const signature = typeof r.signature === 'string' ? r.signature : ''
    if (!annotationId || !signature) continue
    const key = reviewedKey(annotationId, signature)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ annotationId, signature, createdAt: parseTime(r.createdAt) })
  }
  return out
}
