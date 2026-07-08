@echo off
REM tsdown 跨平台构建 shim — CMD 入口
REM Pnpm 在 Windows 上通过 CMD 执行脚本，CMD 需要知道 node 的绝对路径
REM 这个文件被 packages/agent-core/package.json 的 build 命令引用

set "SHIM_DIR=%~dp0"
set "MONOREPO_ROOT=%SHIM_DIR%..\"
node "%MONOREPO_ROOT%scripts\tsdown-shim.mjs" "%CD%"
