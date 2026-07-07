import { describe, it, expect } from 'vitest';
import { inferCategoryTags, CATEGORIES } from '../../src/classifiers/category-tagger.js';

describe('inferCategoryTags', () => {
  it('tags "bug" as bug-fix/修复', () => {
    const tags = inferCategoryTags({ userNeed: 'I fixed the memory leak in production' });
    expect(tags).toContain('bug-fix/修复');
  });

  it('tags "deploy" as deploy/部署', () => {
    const tags = inferCategoryTags({ userNeed: 'I will deploy to the production server' });
    expect(tags).toContain('deploy/部署');
  });

  it('tags "migrate" as migration/迁移', () => {
    const tags = inferCategoryTags({ userNeed: 'I need to migrate the database to v3' });
    expect(tags).toContain('migration/迁移');
  });

  it('tags "query" as search/搜索', () => {
    const tags = inferCategoryTags({ userNeed: 'I optimized the search query performance' });
    expect(tags).toContain('search/搜索');
  });

  it('tags "dream" as dream/整理', () => {
    const tags = inferCategoryTags({ userNeed: 'I ran dream consolidation of memos' });
    expect(tags).toContain('dream/整理');
  });

  it('tags "api" as api/接口', () => {
    const tags = inferCategoryTags({ userNeed: 'I designed the rest api endpoint' });
    expect(tags).toContain('api/接口');
  });

  it('tags "test" as test/测试', () => {
    const tags = inferCategoryTags({ userNeed: 'I wrote integration tests today' });
    expect(tags).toContain('test/测试');
  });

  it('tags "db" as db/数据库', () => {
    const tags = inferCategoryTags({ userNeed: 'I optimized the db query performance' });
    expect(tags).toContain('db/数据库');
  });

  it('tags "sql" as db/数据库', () => {
    const tags = inferCategoryTags({ userNeed: 'I optimized the sql query' });
    expect(tags).toContain('db/数据库');
  });

  it('tags "ui" as ui/界面', () => {
    const tags = inferCategoryTags({ userNeed: 'I built a new ui component today' });
    expect(tags).toContain('ui/界面');
  });

  it('tags "cli" as cli/命令行', () => {
    const tags = inferCategoryTags({ userNeed: 'I built a cli tool' });
    expect(tags).toContain('cli/命令行');
  });

  it('tags "prompt" as prompt/指令', () => {
    const tags = inferCategoryTags({ userNeed: 'I detected a prompt injection attack' });
    expect(tags).toContain('prompt/指令');
  });

  it('tags "tags" as tags/标签', () => {
    const tags = inferCategoryTags({ userNeed: 'I set up auto tag classification' });
    expect(tags).toContain('tags/标签');
  });

  it('returns at most 6 tags', () => {
    const tags = inferCategoryTags({
      userNeed: 'I fixed a bug and deployed with test db api cli search config setup',
    });
    expect(tags.length).toBeLessThanOrEqual(6);
  });

  it('returns empty when nothing matches', () => {
    const tags = inferCategoryTags({ userNeed: 'the weather is very nice outside' });
    expect(tags).toEqual([]);
  });

  it('has at least 12 categories', () => {
    expect(CATEGORIES.length).toBeGreaterThanOrEqual(12);
  });
});
