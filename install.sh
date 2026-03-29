#!/bin/bash
set -e

echo "🚀 玄天监控部署脚本 v1.0"
echo "========================"

# 检测Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js 未安装，请先安装 Node.js 18+"
    exit 1
fi

NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 18 ]; then
    echo "❌ Node.js 版本过低，需要 18+，当前: $(node -v)"
    exit 1
fi

echo "✅ Node.js 版本: $(node -v)"

# 检测systemd
if ! command -v systemctl &> /dev/null; then
    echo "❌ 需要 systemd 支持"
    exit 1
fi

# 创建安装目录
INSTALL_DIR="${OPENCLAW_MONITOR_DIR:-$HOME/.openclaw-monitor}"
echo "📁 安装目录: $INSTALL_DIR"

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# 如果没有文件，则初始化
if [ ! -f index.js ]; then
    echo "📦 初始化监控文件..."
    # 创建必要的文件
    cat > package.json << 'PKGEOF'
{
  "name": "openclaw-monitor",
  "version": "1.0.0",
  "dependencies": {
    "express": "^5.2.1",
    "ws": "^8.20.0"
  }
}
PKGEOF

    # 下载主程序（从GitHub或内嵌）
    echo "⚠️ 请确保已复制 index.js, alert-engine.js 和 public/ 目录到此目录"
    echo "📝 完成后运行: cd $INSTALL_DIR && npm install && systemctl --user enable openclaw-monitor"
    exit 0
fi

# 安装依赖
echo "📦 安装npm依赖..."
npm install --omit=dev 2>&1 | tail -5

# 创建systemd服务
echo "⚙️ 配置systemd服务..."
mkdir -p "$HOME/.config/systemd/user"

cat > "$HOME/.config/systemd/user/openclaw-monitor.service" << SERVICEEOF
[Unit]
Description=玄天监控仪表盘
After=network.target

[Service]
ExecStart=$(command -v node) $INSTALL_DIR/index.js
WorkingDirectory=$INSTALL_DIR
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=default.target
SERVICEEOF

# 启用并启动服务
echo "🚀 启动服务..."
systemctl --user daemon-reload
systemctl --user enable openclaw-monitor
systemctl --user start openclaw-monitor

# 检查状态
sleep 2
if systemctl --user is-active --quiet openclaw-monitor; then
    echo ""
    echo "✅ 部署成功！"
    echo "🌐 访问地址: http://localhost:3000"
    echo "📊 状态查看: systemctl --user status openclaw-monitor"
else
    echo "❌ 服务启动失败，请检查日志: journalctl --user -u openclaw-monitor -n 50"
    exit 1
fi
