import type { DocumentData } from '../types'
import { normalizeIgnored, normalizeRules } from './conflicts'
import { normalizeCoverageTags } from './coverage'
import {
  diffSnapshot,
  migrateReviewedDiffs,
  normalizeBaseline,
  normalizeReviewedDiffs,
} from './snapshot'
import {
  migrateSampleReviews,
  normalizeSampleConfig,
  normalizeSampleReviews,
} from './sampling'
import { normalizeCardinalityRules, normalizeRelations } from './relations'

/** localStorage 键（导出供测试直接写入旧版数据） */
export const STORAGE_KEY = 'anchor-annotation-console:v1'

export function loadDocument(): DocumentData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as Partial<DocumentData>
    if (typeof data.text !== 'string' || !Array.isArray(data.annotations)) {
      return null
    }
    // 旧版数据没有基线与已审记录：无损补空；旧版（U+0001 标签拼接）已审签名在此迁移
    const baseline = normalizeBaseline(data.baseline)
    const snapshotDiffs = diffSnapshot(baseline, data.annotations)
    const reviewedDiffs = migrateReviewedDiffs(
      normalizeReviewedDiffs(data.reviewedDiffs),
      snapshotDiffs,
    )
    return {
      title: typeof data.title === 'string' ? data.title : '未命名文档',
      text: data.text,
      annotations: data.annotations,
      // 旧版本数据没有冲突配置：无损补空
      conflictRules: normalizeRules(data.conflictRules),
      ignoredConflicts: normalizeIgnored(data.ignoredConflicts),
      // 旧版本数据没有覆盖审计配置：无损补空
      coverageTags: normalizeCoverageTags(data.coverageTags),
      baseline,
      reviewedDiffs,
      // 旧版本数据没有抽样复核配置：无损补空
      sampleConfig: normalizeSampleConfig(data.sampleConfig),
      // 旧版本数据没有抽样复核结论：无损补空；旧签名在此迁移，
      // 并剔除内容已变化的失效结论
      sampleReviews: migrateSampleReviews(
        normalizeSampleReviews(data.sampleReviews),
        data.annotations,
      ),
      // 旧版本数据没有标注关系：无损补空（有效性在使用时由两端标注派生）
      relations: normalizeRelations(data.relations),
      // 旧版本数据没有关系基数上限规则：无损补空
      relationCardinalityRules: normalizeCardinalityRules(data.relationCardinalityRules),
      updatedAt: data.updatedAt ?? Date.now(),
    }
  } catch {
    return null
  }
}

export function saveDocument(doc: DocumentData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc))
  } catch {
    // 存储满或隐私模式下静默失败；导出仍可使用
  }
}

export function clearDocument(): void {
  localStorage.removeItem(STORAGE_KEY)
}
