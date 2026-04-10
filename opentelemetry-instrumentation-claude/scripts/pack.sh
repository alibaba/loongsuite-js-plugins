#!/usr/bin/env bash
# pack.sh — 打包 otel-claude-hook 为 OSS tarball
#
# 用法：
#   bash scripts/pack.sh
#
# 输出：dist/otel-claude-hook.tar.gz
#
# 上传到 OSS（需要 ak/sk，让有权限的人执行）：
#   ossutil cp dist/otel-claude-hook.tar.gz \
#     oss://arms-apm-cn-hangzhou-pre/agenttrack/otel-claude-hook.tar.gz \
#     --acl public-read
#
# 上传后验证：
#   curl -fsSL https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/agenttrack/otel-claude-hook.tar.gz -o /dev/null -w "%{http_code}\n"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PKG_DIR/dist"
PLUGIN_NAME="otel-claude-hook"
OUTPUT="$DIST_DIR/${PLUGIN_NAME}.tar.gz"

echo "📦 打包 $PLUGIN_NAME ..."
echo ""

# 创建 dist 目录
mkdir -p "$DIST_DIR"

# 打包（从包根目录，排除无关文件）
# COPYFILE_DISABLE=1 防止 macOS 将 xattr 扩展属性打入 tarball，
# 避免在 Linux 上解压时出现 "Ignoring unknown extended header keyword" 警告
cd "$PKG_DIR"
COPYFILE_DISABLE=1 tar -czf "$OUTPUT" \
    --exclude='node_modules' \
    --exclude='coverage' \
    --exclude='dist' \
    --exclude='.git' \
    --exclude='*.test.js' \
    --exclude='test' \
    --exclude='package-lock.json' \
    bin \
    src \
    scripts/install.sh \
    scripts/setup-alias.sh \
    scripts/uninstall.sh \
    package.json \
    README.md \
    LICENSE

SIZE=$(du -sh "$OUTPUT" | cut -f1)
echo "✅ 打包完成: $OUTPUT ($SIZE)"
echo ""
echo "下一步 — 上传到 OSS（需要有 OSS 写权限的账号执行）："
echo ""
echo "  # 方式 1：ossutil（推荐）"
echo "  ossutil cp $OUTPUT \\"
echo "    oss://arms-apm-cn-hangzhou-pre/agenttrack/${PLUGIN_NAME}.tar.gz \\"
echo "    --acl public-read"
echo ""
echo "  # 方式 2：aliyun CLI"
echo "  aliyun oss cp $OUTPUT \\"
echo "    oss://arms-apm-cn-hangzhou-pre/agenttrack/${PLUGIN_NAME}.tar.gz \\"
echo "    --acl public-read"
echo ""
echo "上传后验证（HTTP 200 = 成功）："
echo "  curl -o /dev/null -sI https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/agenttrack/${PLUGIN_NAME}.tar.gz | head -1"
echo ""
echo "更新后一行安装命令："
echo "  curl -fsSL https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/agenttrack/remote-install.sh | bash"
