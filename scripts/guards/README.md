# Guard 防踩坑检查

## 说明

本目录的 shell 脚本用于在开发流程中自动检查常见踩坑场景，在问题产生前发出警告或阻止操作。

## 使用方式

```bash
# 运行全部 guard（正常模式）
./scripts/guards/check-all.sh

# 运行全部 guard（静默模式，只输出失败）
./scripts/guards/check-all.sh --quiet

# 单独运行某个 guard
./scripts/guards/guard-bundle-stale.sh
```

## 如何新增一个 Guard

1. 在 `scripts/guards/` 下创建 `guard-<name>.sh`，遵循统一接口：
   - exit 0 = 通过
   - exit 1 = 警告
   - exit 2 = 错误
2. 在 `config.sh` 中添加 GUARD_ENABLED_guard_<name>=true 开关
3. `check-all.sh` 自动发现并运行新 guard

## 当前 Guards

| Guard | 作用 | 对应踩坑 |
|-------|------|---------|
| bundle-stale | 源码比 bundle 新 → 提示重建 | 双构建链/构建后不重启/中间产物检查错文件 |
| pnpm-env | 检查 node/git 在 PATH | pnpm prepare Windows 失败 |
| config-build | yaml 配置文件比 bundle 新 → 提示重建 | agent.yaml 改了没 build |
| always-bundle | 检查入口包已构建 | 只 build 中间包忘了 build 入口 |

## 设计原则

- 只检查不修复（安全网，不是自动修复工具）
- 简单 shell 脚本，无依赖
- 统一退出码接口
- 可通过 config.sh 独立开关
- 与 scream-dev 互补（guard 检出问题 → scream-dev 自动修复）
