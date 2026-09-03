# Windows 一键发布脚本(需 npm 已登录/有 bypass-2FA 令牌)
# 用法:在 dist/dsh-agent-hub 目录运行后,自动 npm version + publish
param(
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Step = 'patch'
)
$ErrorActionPreference = 'Stop'
npm version $Step
npm publish
Write-Host "Published. Then: git push && gh release create v$(node -p "require('./package.json').version")"
