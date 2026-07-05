/**
 * ContentHashCache — 跨步内容去重
 *
 * 优化 C: 当注入内容与上一步的相同 variant 内容一致时跳过，避免缓存反复失效。
 * 锁定前缀保证注入文本头部一致即可视为相同内容（忽略后续差异），
 * 因为前缀决定了最关键的缓存影响区（position-strategy 决策位置）。
 *
 * 使用: turn/index.ts inject() 中，stepInjectedVariants 去重之后、
 * VariantScheduler 调度之前。
 */
export class ContentHashCache {
  /** 最近注入的每个 variant 的内容 hash 快照 */
  private lastHashes = new Map<string, string>();

  /**
   * 检查 variant+content 是否与上一步重复
   * @returns true 表示内容重复，应跳过本次注入
   */
  isDuplicate(variant: string, content: string, prefixLen = 60): boolean {
    const key = this.variantKey(variant);
    const hash = this.computeHash(content, prefixLen);
    const last = this.lastHashes.get(key);
    if (last === hash) return true;
    this.lastHashes.set(key, hash);
    return false;
  }

  /** 重置（compaction 后调用，因上下文状态改变了注入的必要性） */
  reset(): void {
    this.lastHashes.clear();
  }

  /** 移除指定 variant 的缓存条目 */
  clearVariant(variant: string): void {
    this.lastHashes.delete(this.variantKey(variant));
  }

  /** 缓存条目数 */
  get size(): number {
    return this.lastHashes.size;
  }

  private variantKey(variant: string): string {
    // 对带 step 编号的 variant（如 "post_step"）归一化，去数字后缀
    return variant.replace(/_\d+$/, '');
  }

  /**
   * 取内容前 prefixLen 字符的快速 hash。
   * 注入内容的前缀最稳定（如 "系统指令初始化：..."），后半部分可能含动态参数。
   * 截取前缀做 hash 既保证去重效果又避免全量 hash 开销。
   */
  private computeHash(content: string, prefixLen: number): string {
    const slice = content.slice(0, prefixLen);
    let h = 0;
    for (let i = 0; i < slice.length; i++) {
      h = ((h << 5) - h + slice.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }
}