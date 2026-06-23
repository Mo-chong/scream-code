/**
 * Fallback skill marketplace shipped with the binary.
 *
 * Used when the remote marketplace cannot be fetched at runtime.
 */

export interface FallbackMarketplaceEntry {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly source: string;
}

export const FALLBACK_SKILL_MARKETPLACE: readonly FallbackMarketplaceEntry[] = [
  {
    id: 'gsap-skills',
    displayName: 'GSAP 动画技能包',
    description:
      'GreenSock 动画平台全套参考手册，含核心 API、Timeline、ScrollTrigger、插件、React 集成等 8 个技能',
    source: 'https://github.com/greensock/gsap-skills',
  },
  {
    id: 'claude-design-card',
    displayName: 'Claude Design Card',
    description: '14 种设计卡片生成（封面/图文/社交分享/长篇排版），Parchment × Swiss 双风格体系',
    source: 'https://github.com/geekjourneyx/claude-design-card',
  },
  {
    id: 'superpowers',
    displayName: 'Superpowers 开发技能包',
    description:
      '14 个开发方法论技能：TDD、系统调试、代码审查、子代理驱动开发、并行代理、头脑风暴等',
    source: 'https://github.com/obra/superpowers',
  },
  {
    id: 'audio-skill',
    displayName: 'Audio Skill 录音分析',
    description: '本地录音分析自动化，含 RAG 知识库。适用于销售录音复盘、会议纪要、质量评分等',
    source: 'https://github.com/LIUTod/audio-skill',
  },
  {
    id: 'scrapling-skill',
    displayName: 'Scrapling 网页爬取',
    description: '基于 Scrapling 的智能爬虫技能，支持 Cloudflare/WAF 绕过、登录会话、自动抓取解析',
    source: 'https://github.com/Cedriccmh/claude-code-skill-scrapling',
  },
  {
    id: 'a-stock-data',
    displayName: 'A 股数据分析',
    description:
      'A 股市场数据查询分析，27 个接口覆盖行情/研报/资金流/新闻/基本面，含 4 套内置研究流程',
    source: 'https://github.com/simonlin1212/a-stock-data',
  },
  {
    id: 'humanizer',
    displayName: 'Humanizer AI 文本去味',
    description: '去除 AI 写作痕迹：30 种 AI 模式检测 × 5 大类 × 语音校准，输出纯正人类文风',
    source: 'https://github.com/blader/humanizer',
  },
  {
    id: 'patent-disclosure-skill',
    displayName: 'Patent Disclosure 专利交底书',
    description:
      '专利交底书自动生成：专利点挖掘 → 国知局查新 → 脱敏成文 → 自检闭环，Mermaid 附图，输出 .docx',
    source: 'https://github.com/handsomestWei/patent-disclosure-skill',
  },
  {
    id: 'contract-review-pro',
    displayName: 'Contract Review Pro 合同审查',
    description:
      '专业合同审查：7 步工作流 × 5 强制关 × 15 类风险标签 × 六维评估，输出批注合同+法律意见书+分析备忘录，支持 30 种合同类型',
    source: 'https://github.com/CSlawyer1985/contract-review-pro',
  },
  {
    id: 'academic-research-skills',
    displayName: 'Academic Research 学术研究',
    description:
      '完整学术研究管线：深度研究（13 Agent 团队 × 7 种模式）+ 学术写作（12 Agent 管线）+ 同行评审（7 Agent 多视角审稿），全流程覆盖',
    source: 'https://github.com/Imbad0202/academic-research-skills',
  },
  {
    id: 'headroom',
    displayName: 'Headroom 压缩优化',
    description: '在内容送达 LLM 前压缩工具输出、日志、文件和 RAG 块，节省 60-95% Token，答案质量不变',
    source: 'https://github.com/chopratejas/headroom',
  },
  {
    id: 'xiaohu-wechat-format',
    displayName: '小壶公众号排版',
    description: 'Markdown → 微信兼容 HTML → 推送草稿箱，30 套主题 + 可视化画廊，一键排版发布',
    source: 'https://github.com/xiaohuailabs/xiaohu-wechat-format',
  },
  {
    id: 'huashu-design',
    displayName: '花束设计',
    description: 'HTML 原生设计技能：高保真原型 / 幻灯片 / 动画 + 20 设计哲学 + 5 维评审 + MP4 导出',
    source: 'https://github.com/alchaincyf/huashu-design',
  },
  {
    id: 'html-video',
    displayName: 'HTML Video 视频生成',
    description: 'HTML 转 MP4：可插拔渲染引擎 + 21 套模板 + AI 配乐，全程本地，零渲染费用',
    source: 'https://github.com/nexu-io/html-video',
  },
  {
    id: 'xiaohu-video-translate',
    displayName: '小壶视频翻译',
    description: '外语视频自动配中文字幕：下载 / 转写 / 翻译 / 润色 / 烧录一条龙，全程本地',
    source: 'https://github.com/xiaohuailabs/xiaohu-video-translate',
  },
  {
    id: 'videocut-skills',
    displayName: '视频剪辑 Agent',
    description: 'Claude Code Skills 驱动的视频剪辑 Agent：口播剪辑 / 字幕导入 / 画质高清化',
    source: 'https://github.com/Ceeon/videocut-skills',
  },
  {
    id: 'taste-skill',
    displayName: 'Taste Skill 设计品味',
    description: '给 AI 好品味：阻止生成无聊通用的设计，输出有质感的方案',
    source: 'https://github.com/Leonxlnx/taste-skill',
  },
  {
    id: 'vtake-skills',
    displayName: 'VTake 视频剪辑',
    description: 'Agent Skills 驱动的视频剪辑工具',
    source: 'https://github.com/notedit/vtake-skills',
  },
  {
    id: 'remotion-skills',
    displayName: 'Remotion 视频技能',
    description: 'Remotion（React 视频框架）官方技能包',
    source: 'https://github.com/remotion-dev/skills',
  },
  {
    id: 'html-anything',
    displayName: 'HTML Anything 全能设计',
    description: '75 个技能 × 9 种场景：杂志 / 幻灯片 / 海报 / 小红书 / 数据报告 / 原型，零 API 密钥',
    source: 'https://github.com/nexu-io/html-anything',
  },
  {
    id: 'guizang-social-card-skill',
    displayName: '归藏社交卡片',
    description:
      '小红书轮播图 + 公众号封面：28 种布局 × 10 套主题，Editorial × Swiss 视觉体系，单文件 HTML → PNG',
    source: 'https://github.com/op7418/guizang-social-card-skill',
  },
];
