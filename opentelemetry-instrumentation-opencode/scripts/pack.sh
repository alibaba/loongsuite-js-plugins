#!/usr/bin/env bash
# pack.sh — 打包 opentelemetry-instrumentation-opencode 为 OSS tarball
#
# 用法：
#   bash scripts/pack.sh
#
# 输出：dist/opentelemetry-instrumentation-opencode.tar.gz
#
# 上传到 OSS（需要有权限的账号执行）：
#   ossutil cp dist/opentelemetry-instrumentation-opencode.tar.gz \
#     oss://your-bucket/your-path/opentelemetry-instrumentation-opencode.tar.gz \
#     --acl public-read

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PKG_DIR/dist"
PLUGIN_NAME="opentelemetry-instrumentation-opencode"
OUTPUT="$DIST_DIR/${PLUGIN_NAME}.tar.gz"

echo "📦 打包 $PLUGIN_NAME ..."
echo ""

mkdir -p "$DIST_DIR"

# 复制到临时目录，清除 xattr（macOS 会写 com.apple.provenance 等元数据，带到 Linux 会报警）
PACK_TMPDIR=$(mktemp -d)
trap 'rm -rf "$PACK_TMPDIR"' EXIT

cd "$PKG_DIR"

if [[ "$(uname -s)" == "Darwin" ]]; then
    CP_FLAGS="-rX"
else
    CP_FLAGS="-r"
fi

cp $CP_FLAGS src package.json README.md LICENSE "$PACK_TMPDIR/"
mkdir -p "$PACK_TMPDIR/scripts"
cp scripts/install.sh scripts/uninstall.sh "$PACK_TMPDIR/scripts/"

# 双保险：清除所有残留 xattr
xattr -cr "$PACK_TMPDIR" 2>/dev/null || true

COPYFILE_DISABLE=1 tar -czf "$OUTPUT" -C "$PACK_TMPDIR" .

SIZE=$(du -sh "$OUTPUT" | cut -f1)
echo "✅ 打包完成: $OUTPUT ($SIZE)"
echo ""
echo "下一步 — 上传到 OSS："
echo ""
echo "  ossutil cp $OUTPUT \\"
echo "    oss://your-bucket/your-path/${PLUGIN_NAME}.tar.gz \\"
echo "    --acl public-read"
echo ""
echo "上传后验证："
echo "  curl -o /dev/null -sI https://your-bucket.oss-region.aliyuncs.com/your-path/${PLUGIN_NAME}.tar.gz | head -1"
echo ""
echo "一行安装命令："
echo "  curl -fsSL https://your-bucket.oss-region.aliyuncs.com/your-path/remote-install.sh | bash"
