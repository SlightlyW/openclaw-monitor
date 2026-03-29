/**
 * 告警收敛引擎 — Alert Deduplication & Aggregation
 * 
 * 核心设计：
 * - 告警去重key：host + metric + alert_type
 * - 5分钟内同类告警只保留最新状态，不重复轰炸
 * - 告警状态：pending → firing → resolved
 * - 恢复通知：告警恢复时也发送通知
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ALERT_STATE_FILE = 'process.env.HOME + '/.openclaw'/monitor/alert-state.json';
const ALERT_HISTORY_FILE = 'process.env.HOME + '/.openclaw'/monitor/alert-history.json';
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5分钟去重窗口

// 确保目录存在
function ensureDir() {
  const dir = path.dirname(ALERT_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 读取当前告警状态
function loadState() {
  ensureDir();
  try {
    if (fs.existsSync(ALERT_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(ALERT_STATE_FILE, 'utf-8'));
    }
  } catch(e) {}
  return { alerts: {}, history: [] };
}

// 保存告警状态
function saveState(state) {
  ensureDir();
  fs.writeFileSync(ALERT_STATE_FILE, JSON.stringify(state, null, 2));
}

// 生成告警唯一key
function makeAlertKey(host, metric, level) {
  return `${host}::${metric}::${level}`;
}

// 记录历史
function addHistory(alert, status) {
  const state = loadState();
  state.history.unshift({
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    key: alert.key,
    name: alert.name,
    host: alert.host,
    metric: alert.metric,
    value: alert.value,
    threshold: alert.threshold,
    level: alert.level,
    status, // 'firing' | 'resolved'
    firedAt: alert.firedAt,
    resolvedAt: status === 'resolved' ? Date.now() : null,
    duration: alert.firedAt ? Date.now() - alert.firedAt : 0,
  });
  // 只保留最近1000条
  if (state.history.length > 1000) state.history = state.history.slice(0, 1000);
  saveState(state);
}

// 检查是否在去重窗口内
function isDuplicate(alertKey, value) {
  const state = loadState();
  const existing = state.alerts[alertKey];
  if (!existing) return false;
  // 5分钟内同类告警，如果值相近认为是重复
  const timeDiff = Date.now() - existing.lastSeen;
  return timeDiff < DEDUP_WINDOW_MS;
}

// 触发告警
async function fireAlert(alert) {
  const state = loadState();
  const alertKey = alert.key;
  const existing = state.alerts[alertKey];

  if (existing && existing.status === 'firing') {
    // 已存在的告警只更新时间戳和值
    existing.lastSeen = Date.now();
    existing.value = alert.value;
    existing.count = (existing.count || 1) + 1;
    saveState(state);
    return { action: 'updated', alert: existing };
  }

  // 新告警
  const newAlert = {
    ...alert,
    key: alertKey,
    status: 'firing',
    firedAt: existing?.firedAt || Date.now(),
    lastSeen: Date.now(),
    count: existing ? (existing.count || 1) + 1 : 1,
  };

  state.alerts[alertKey] = newAlert;
  saveState(state);

  // 发送通知
  await sendNotification(newAlert, 'firing');

  // 记录历史
  addHistory(newAlert, 'firing');

  return { action: 'fired', alert: newAlert };
}

// 恢复告警
async function resolveAlert(alertKey) {
  const state = loadState();
  const existing = state.alerts[alertKey];
  if (!existing || existing.status !== 'firing') return null;

  existing.status = 'resolved';
  existing.resolvedAt = Date.now();
  existing.lastSeen = Date.now();
  saveState(state);

  // 发送恢复通知
  await sendNotification(existing, 'resolved');

  // 记录历史
  addHistory(existing, 'resolved');

  return { action: 'resolved', alert: existing };
}

// 发送飞书通知
async function sendNotification(alert, status) {
  const levelEmoji = { P0: '🔴', P1: '🟠', P2: '🟡', P3: '⚪' };
  const emoji = levelEmoji[alert.level] || '🔔';

  let msg = '';
  if (status === 'firing') {
    msg = `${emoji} **告警触发**\n\n` +
      `**告警名称**：${alert.name}\n` +
      `**级别**：${alert.level}\n` +
      `**主机**：${alert.host}\n` +
      `**指标**：${alert.metric}\n` +
      `**当前值**：${alert.value}${alert.unit}\n` +
      `**阈值**：${alert.threshold}${alert.unit}\n` +
      `**触发次数**：${alert.count}次\n` +
      `**触发时间**：${new Date(alert.firedAt).toLocaleString('zh-CN')}`;
  } else {
    const duration = alert.resolvedAt - alert.firedAt;
    const durationStr = duration > 60000 ? `${Math.floor(duration/60000)}分钟` : `${Math.floor(duration/1000)}秒`;
    msg = `${emoji} **告警恢复**\n\n` +
      `**告警名称**：${alert.name}\n` +
      `**级别**：${alert.level}\n` +
      `**主机**：${alert.host}\n` +
      `**持续时间**：${durationStr}\n` +
      `**恢复时间**：${new Date(alert.resolvedAt).toLocaleString('zh-CN')}`;
  }

  // 通过飞书机器人发送（如果有配置）
  await sendFeishuAlert(msg);
}

// 发送飞书消息
async function sendFeishuAlert(message) {
  // 读取飞书机器人配置
  const feishuWebhook = process.env.FEISHU_ALERT_WEBHOOK;
  if (!feishuWebhook) {
    console.log('[Alert] 无飞书Webhook配置，消息不发送:', message.substring(0, 50));
    return;
  }

  try {
    const payload = {
      msg_type: 'text',
      content: { text: message }
    };
    const res = await fetch(feishuWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log('[Alert] 飞书通知发送结果:', res.ok);
  } catch(e) {
    console.error('[Alert] 飞书通知发送失败:', e.message);
  }
}

// 定时检测：检查告警是否恢复
function checkResolutions(metrics) {
  const state = loadState();
  const now = Date.now();

  for (const [key, alert] of Object.entries(state.alerts)) {
    if (alert.status !== 'firing') continue;

    // 检查是否超过10分钟没有再次触发（视为恢复）
    if (now - alert.lastSeen > 10 * 60 * 1000) {
      resolveAlert(key);
    }
  }
}

// 评估告警规则
async function evaluateRules(metrics) {
  // metrics格式: { cpu: {usage: 45}, mem: {pct: 60}, disk: {pct: 35}, ports: [...] }
  const rules = [
    { name: 'CPU过高', metric: 'cpu.usage', level: 'P2', threshold: 80, unit: '%', host: '本机' },
    { name: 'CPU紧急', metric: 'cpu.usage', level: 'P0', threshold: 95, unit: '%', host: '本机' },
    { name: '内存不足', metric: 'mem.pct', level: 'P2', threshold: 85, unit: '%', host: '本机' },
    { name: '内存紧急', metric: 'mem.pct', level: 'P0', threshold: 95, unit: '%', host: '本机' },
    { name: '磁盘爆满', metric: 'disk.pct', level: 'P1', threshold: 85, unit: '%', host: '本机' },
    { name: '磁盘紧急', metric: 'disk.pct', level: 'P0', threshold: 95, unit: '%', host: '本机' },
  ];

  for (const rule of rules) {
    const value = getMetricValue(metrics, rule.metric);
    if (value === null) continue;

    const alert = {
      name: rule.name,
      host: rule.host,
      metric: rule.metric,
      level: rule.level,
      value,
      threshold: rule.threshold,
      unit: rule.unit,
      key: makeAlertKey(rule.host, rule.metric, rule.level),
    };

    if (value >= rule.threshold) {
      await fireAlert(alert);
    }
  }

  // 检查恢复
  checkResolutions(metrics);
}

// 获取嵌套指标值
function getMetricValue(obj, path) {
  const parts = path.split('.');
  let val = obj;
  for (const p of parts) {
    if (val === null || val === undefined) return null;
    val = val[p];
  }
  return typeof val === 'number' ? val : null;
}

// HTTP API — 获取告警状态
function getAlertState() {
  return loadState();
}

// HTTP API — 获取告警历史
function getAlertHistory(limit = 50) {
  const state = loadState();
  return state.history.slice(0, limit);
}

module.exports = {
  evaluateRules,
  fireAlert,
  resolveAlert,
  getAlertState,
  getAlertHistory,
  sendNotification,
};
