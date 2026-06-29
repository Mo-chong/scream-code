import type { MemoryMemo } from '../models.js';

// ─── Rule-based category tag inference ──────────────────────────────────────
// Scans memo text for domain keywords and appends structured category tags.
// Configurable via CATEGORIES array; no AI dependency, runs in microsecond time.

export interface CategoryRule {
  pattern: RegExp;
  tag: string;
}

/** Built-in category rules. Ordered by specificity; rules are checked independently (not first-match). */
export const CATEGORIES: CategoryRule[] = [
  { pattern: /(bug|fix|error|crash|修复|错误|异常|异常处理)/i, tag: 'bug-fix/修复' },
  { pattern: /(install|setup|config|部署|安装|配置|deploy|deployment)/i, tag: 'deploy/部署' },
  { pattern: /(upgrade|update|migrate|迁移|升级|版本|version|v\d+\.\d+)/i, tag: 'migration/迁移' },
  { pattern: /(搜索|召回|match|score|相似度|查询|query|rank|rerank)/i, tag: 'search/搜索' },
  { pattern: /(标签|tag|分类|class|category)/i, tag: 'tags/标签' },
  { pattern: /(dream|整理|合并|dedup|去重|consolid|duplicate|group)/i, tag: 'dream/整理' },
  { pattern: /(prompt|inject|注入|指令|system|代理|agent|subagent)/i, tag: 'prompt/指令' },
  { pattern: /(api|interface|contract|约定|规范|endpoint|router|middleware)/i, tag: 'api/接口' },
  { pattern: /(测试|test|spec|assert|验证|verify|snapshot|e2e|集成)/i, tag: 'test/测试' },
  { pattern: /(数据库|db|sql|sqlite|mongo|postgres|存储|store|存储引擎)/i, tag: 'db/数据库' },
  { pattern: /(ui|界面|界面|前端|frontend|组件|component|页面|page|视图|view)/i, tag: 'ui/界面' },
  { pattern: /(cli|命令行|terminal|bash|shell|终端|命令|cmd)/i, tag: 'cli/命令行' },
  // ── Extended categories (Phase 3b: 22 total) ──
  { pattern: /(安全|security|auth|权限|permission|认证|authenticate|role|角色|授权)/i, tag: '安全/security' },
  { pattern: /(性能|performance|速度|latency|延迟|throughput|吞吐|optimize|优化|bottleneck|瓶颈)/i, tag: '性能/performance' },
  { pattern: /(日志|log|logging|trace|tracing|监控|monitor|告警|alert|metric)/i, tag: '日志/logging' },
  { pattern: /(重构|refactor|refactoring|清理|cleanup|遗留|legacy|tech.debt|技术债务)/i, tag: '重构/refactor' },
  { pattern: /(文档|docs|documentation|readme|wiki|说明书|manual|guide|指南)/i, tag: '文档/docs' },
  { pattern: /(发布|release|rollout|灰度|canary|回滚|rollback|发版|changelog)/i, tag: '发布/release' },
  { pattern: /(审查|review|CR|code.review|审批|approve|audit|审计)/i, tag: '审查/review' },
  { pattern: /(容器|docker|container|k8s|kubernetes|镜像|image|编排|orchestrat)/i, tag: '容器/container' },
  { pattern: /(ci|cd|pipeline|流水线|github.action|gitlab|jenkins|构建|build)/i, tag: 'CI/CD' },
  { pattern: /(备份|backup|恢复|restore|快照|snapshot|容灾|disaster)/i, tag: '备份/backup' },
];

/**
 * Infer category tags from a memo's text content.
 * Returns all matching category tags (max 6 to avoid tag bloat).
 * @param extraCategories - Optional additional rules appended after built-in CATEGORIES.
 */
export function inferCategoryTags(
  memo: Partial<Pick<MemoryMemo, 'userNeed' | 'approach' | 'outcome' | 'whatFailed' | 'whatWorked'>>,
  extraCategories?: CategoryRule[],
): string[] {
  const text = [memo.userNeed, memo.approach, memo.outcome, memo.whatFailed, memo.whatWorked]
    .filter(Boolean)
    .join(' ');

  const allRules = extraCategories ? [...CATEGORIES, ...extraCategories] : CATEGORIES;

  return allRules
    .filter((r) => r.pattern.test(text))
    .map((r) => r.tag)
    .slice(0, 6); // cap to avoid tag bloat
}
