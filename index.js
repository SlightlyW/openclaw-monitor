const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const alertEngine = require('./alert-engine');

const app = express();
const PORT = 3000;
const SESSIONS_FILE = 'process.env.HOME + '/.openclaw'/agents/main/sessions/sessions.json';

let cache = { sessions: [], gatewayConnected: false, updatedAt: null };

// 后台定时采样CPU使用率（每秒一次，计算滑动平均）
let cpuBgPrev = null;
let cpuBgReadings = [];
setInterval(() => {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf-8');
    const line = stat.split('\n')[0];
    const vals = line.split(/\s+/).slice(1).map(Number);
    const total = vals.reduce((a, b) => a + b, 0);
    const idle = vals[3];
    if (!cpuBgPrev) { cpuBgPrev = { total, idle }; return; }
    const totalDelta = total - cpuBgPrev.total;
    const idleDelta = idle - cpuBgPrev.idle;
    cpuBgPrev = { total, idle };
    if (totalDelta <= 0) return;
    const usage = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
    cpuBgReadings.push(usage);
    if (cpuBgReadings.length > 3) cpuBgReadings.shift();
  } catch(e) {}
}, 1000);

function refresh() {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const entries = Object.entries(data);
    
    cache.sessions = entries.slice(0, 20).map(([key, s]) => {
      const parts = key.split(':');
      const now = Date.now();
      const age = s.updatedAt ? now - s.updatedAt : 0;
      const ctx = s.contextTokens || 200000;
      const inp = s.inputTokens || 0;
      const pct = ctx > 0 ? Math.round((inp / ctx) * 100) : 0;
      return {
        key,
        model: s.model || 'MiniMax-M2.7',
        age,
        percentUsed: pct,
        contextTokens: ctx,
        inputTokens: inp,
        outputTokens: s.outputTokens || 0,
        channel: parts[2] || 'unknown',
        agentId: parts[1] || 'main'
      };
    });
    cache.gatewayConnected = true;
    cache.updatedAt = new Date().toISOString();
  } catch (e) {
    cache.gatewayConnected = false;
  }
}

setInterval(refresh, 3000);
refresh();

app.use(express.static(path.join(__dirname, 'public')));

// Vue Router history mode fallback
app.get(/^(?!\/api).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
  refresh();
  res.json(cache);
});

// CPU使用率（从后台采样读取，1秒刷新一次）
function getCpuUsage() {
  if (cpuBgReadings.length === 0) return 0;
  return Math.round(cpuBgReadings.reduce((a, b) => a + b, 0) / cpuBgReadings.length);
}

app.get('/api/system', (req, res) => {
  try {
    const cpus = require('os');
    const loadavg = cpus.loadavg();
    const totalMem = cpus.totalmem();
    const freeMem = cpus.freemem();
    const usedMem = totalMem - freeMem;
    const memPct = Math.round(usedMem / totalMem * 100);

    let diskPct = 0, diskTotal = 0, diskUsed = 0;
    try {
      const dOut = execSync('df -B1 / | tail -1', {timeout:3000}).toString().trim().split(/\s+/);
      diskTotal = parseInt(dOut[1]||'0'); diskUsed = parseInt(dOut[2]||'0'); diskPct = parseInt(dOut[4]||'0');
    } catch(e) {}

    let uptime = '-';
    try {
      const up = parseFloat(execSync('cat /proc/uptime', {timeout:2000}).toString().trim());
      const days = Math.floor(up/86400), hours = Math.floor((up%86400)/3600), mins = Math.floor((up%3600)/60);
      uptime = days > 0 ? `${days}d ${hours}h` : `${hours}h ${mins}m`;
    } catch(e) {}

    let procs = [];
    try {
      const pOut = execSync('ps aux --sort=-%cpu | head -8 | tail -6 | awk \'{print $11" "$2" "$4" "$3}\'', {timeout:5000}).toString().trim();
      procs = pOut.split('\n').filter(Boolean).map(l => { const p = l.split(/\s+/); return {name:p[0]||'', pid:p[1]||'', cpu:p[2]||'', mem:p[3]||''}; });
    } catch(e) {}

    const cpuUsage = getCpuUsage();

    res.json({ cpu: {usage: cpuUsage, load: loadavg[0]}, mem: {used: usedMem, total: totalMem, pct: memPct}, disk: {used: diskUsed, total: diskTotal, pct: diskPct}, uptime, procs });
  } catch(e) { res.json({error: e.message}); }
});

app.get('/api/cron', (req, res) => {
  try {
    const cronJobs = JSON.parse(fs.readFileSync('process.env.HOME + '/.openclaw'/cron/jobs.json', 'utf-8'));
    res.json({ jobs: cronJobs.jobs.map(j => ({
      id: j.id,
      name: j.name,
      description: j.description,
      schedule: j.schedule.expr,
      tz: j.schedule.tz,
      enabled: j.enabled,
      sessionTarget: j.sessionTarget,
      timeoutSeconds: j.payload.timeoutSeconds,
      state: {
        nextRunAtMs: j.state.nextRunAtMs,
        nextRunAt: j.state.nextRunAtMs ? new Date(j.state.nextRunAtMs).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'}) : null,
        lastRunAtMs: j.state.lastRunAtMs,
        lastRunAt: j.state.lastRunAtMs ? new Date(j.state.lastRunAtMs).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'}) : null,
        lastRunStatus: j.state.lastRunStatus,
        lastError: j.state.lastError || null,
        consecutiveErrors: j.state.consecutiveErrors || 0
      }
    }))});
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/api/tokens', (req, res) => {
  try {
    const sessionsFile = 'process.env.HOME + '/.openclaw'/agents/main/sessions/sessions.json';
    const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    let totalInput = 0, totalOutput = 0, totalCost = 0;
    const now = Date.now();
    const recent = Object.entries(data).filter(([k, v]) => {
      const age = v.updatedAt ? now - v.updatedAt : 0;
      return age < 86400000; // last 24h
    });
    recent.forEach(([k, v]) => {
      totalInput += v.inputTokens || 0;
      totalOutput += v.outputTokens || 0;
      totalCost += v.estimatedCostUsd || 0;
    });
    res.json({
      sessions: recent.length,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCostUsd: totalCost.toFixed(4),
      period: '24h'
    });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/api/gwlogs', (req, res) => {
  exec('journalctl --user -u openclaw-gateway -n 80 --no-pager 2>/dev/null; echo "---FEISHU---"; tail -30 ~/.openclaw/logs/openclaw.log 2>/dev/null', {timeout:8000, killSignal:'SIGKILL'}, (e, out) => {
    res.json({ logs: out.split('\n').filter(l => l.trim()) });
  });
});

app.get('/api/agents', (req, res) => {
  try {
    const agentsDir = 'process.env.HOME + '/.openclaw'/agents';
    const dirs = require('fs').readdirSync(agentsDir);
    const agents = dirs.map(id => {
      try {
        const cfg = JSON.parse(require('fs').readFileSync(`${agentsDir}/${id}/agent/agent.json`, 'utf-8'));
        const sessionsFile = `${agentsDir}/${id}/sessions/sessions.json`;
        let sessionCount = 0;
        try {
          const sess = JSON.parse(require('fs').readFileSync(sessionsFile, 'utf-8'));
          sessionCount = Object.keys(sess).length;
        } catch(e) {}
        return {
          id,
          name: cfg.name || id,
          description: cfg.description || '',
          model: cfg.model || '-',
          workspaceDir: cfg.workspaceDir || '',
          sessionCount,
          bootstrapPending: cfg.bootstrapPending || false
        };
      } catch(e) {
        return { id, name: id, error: e.message };
      }
    });
    res.json({ agents });
  } catch(e) { res.json({ error: e.message }); }
});

app.post('/api/sessions/:sessionId/kill', (req, res) => {
  const kid = spawn('openclaw', ['sessions', 'stop', req.params.sessionId], { timeout: 5000 });
  kid.on('close', () => res.json({ ok: true }));
  kid.on('error', () => res.json({ ok: false }));
});

app.post('/api/gateway/restart', (req, res) => {
  const svc = spawn('systemctl', ['--user', 'restart', 'openclaw-gateway']);
  svc.on('close', () => res.json({ ok: true }));
  svc.on('error', () => res.json({ ok: false }));
});

// === 增强API ===

// 多分区磁盘信息
app.get('/api/disk', (req, res) => {
  try {
    const out = execSync('df -B1 --output=target,size,used,avail,pcent 2>/dev/null | tail -n +2', {timeout: 5000}).toString();
    const lines = out.trim().split('\n');
    const disks = lines.map(l => {
      const p = l.trim().split(/\s+/);
      return { mount: p[0], total: parseInt(p[1]||0), used: parseInt(p[2]||0), avail: parseInt(p[3]||0), pct: parseInt(p[4]||0) };
    }).filter(d => d.total > 0);
    res.json({ disks });
  } catch(e) { res.json({ error: e.message, disks: [] }); }
});

// 网卡IO速率
app.get('/api/network', (req, res) => {
  const readNet = () => {
    try {
      const out = execSync("cat /proc/net/dev | grep -E 'eth0|ens|enp|wlp' | head -5", {timeout: 3000}).toString();
      return out.trim().split('\n').map(l => {
        const parts = l.trim().split(/\s+/);
        const name = parts[0].replace(':', '');
        return { name, rx: parseInt(parts[1]||0), tx: parseInt(parts[9]||0) };
      });
    } catch(e) { return []; }
  };
  const before = readNet();
  setTimeout(() => {
    const after = readNet();
    const result = after.map((a, i) => ({
      name: a.name,
      rx: Math.max(0, a.rx - (before[i]?.rx||0)),
      tx: Math.max(0, a.tx - (before[i]?.tx||0))
    }));
    res.json({ networks: result });
  }, 1000);
});

// 完整进程列表
app.get('/api/processes', (req, res) => {
  try {
    const out = execSync('ps aux --sort=-%cpu | head -31 | tail -30 | awk \'{print $2" "$3" "$4" "$11}\'', {timeout: 5000}).toString();
    const procs = out.trim().split('\n').filter(Boolean).map(l => {
      const p = l.trim().split(/\s+/);
      return { pid: p[0]||'', cpu: p[1]||'0', mem: p[2]||'0', name: p.slice(3).join(' ') };
    });
    res.json({ procs });
  } catch(e) { res.json({ error: e.message, procs: [] }); }
});

// Docker容器状态
app.get('/api/docker', (req, res) => {
  try {
    const out = execSync('docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}" 2>/dev/null', {timeout: 5000}).toString();
    const containers = out.trim().split('\n').filter(Boolean).map(l => {
      const p = l.split('|');
      const state = p[4] || 'unknown';
      return {
        id: p[0]||'',
        name: p[1]||'',
        image: p[2]||'',
        status: p[3]||'',
        state: state.toLowerCase().includes('Up') ? 'running' : state.toLowerCase().includes('Exited') ? 'exited' : 'paused',
        cpuPct: 0,
        memPct: 0
      };
    });
    res.json({ containers });
  } catch(e) { res.json({ error: e.message, containers: [] }); }
});

// 端口检测
app.get('/api/ports', (req, res) => {
  const checkPort = (port) => new Promise(resolve => {
    const net = require('net');
    const start = Date.now();
    const sock = net.createConnection({ host: '127.0.0.1', port: parseInt(port), timeout: 2000 });
    sock.on('connect', () => { sock.destroy(); resolve({ port, ok: true, latency: Date.now() - start }); });
    sock.on('error', () => resolve({ port, ok: false, latency: 0 }));
    sock.on('timeout', () => { sock.destroy(); resolve({ port, ok: false, latency: 0 }); });
  });

  const defaultPorts = [22, 80, 443, 3000, 18789, 3306, 5432, 6379, 27017];
  Promise.all(defaultPorts.map(checkPort)).then(results => {
    res.json({ ports: results });
  });
});

// 告警规则（模拟）
app.get('/api/alerts', (req, res) => {
  res.json({ rules: [
    { id: 1, name: 'CPU过高', condition: 'cpu >', value: 80, unit: '%', enabled: true },
    { id: 2, name: '内存不足', condition: 'mem >', value: 90, unit: '%', enabled: true },
    { id: 3, name: '磁盘爆满', condition: 'disk >', value: 85, unit: '%', enabled: true },
  ]});
});

app.get('/api/alert-history', (req, res) => {
  const limit = parseInt(req.query.limit || 50);
  const history = alertEngine.getAlertHistory(limit);
  res.json({ history });
});

// 告警状态
app.get('/api/alert-state', (req, res) => {
  const state = alertEngine.getAlertState();
  res.json({ alerts: Object.values(state.alerts), count: Object.keys(state.alerts).length });
});

// 测试告警（手动触发）
app.post('/api/alert-test', (req, res) => {
  alertEngine.fireAlert({
    name: '测试告警',
    host: '本机',
    metric: 'test',
    level: 'P2',
    value: 99,
    threshold: 80,
    unit: '%',
    key: '本机::test::P2',
  }).then(r => res.json(r));
});

// 定时评估告警规则（每30秒）
setInterval(() => {
  try {
    const cpus = require('os');
    const loadavg = cpus.loadavg();
    const totalMem = cpus.totalmem();
    const freeMem = cpus.freemem();
    const memPct = Math.round((totalMem - freeMem) / totalMem * 100);
    const cpuCount = cpus.cpus().length;
    const cpuPct = Math.min(100, Math.round(loadavg[0] / cpuCount * 100));
    let diskPct = 35;
    try {
      const dOut = execSync('df -B1 / | tail -1', {timeout:3000}).toString().trim().split(/\s+/);
      diskPct = parseInt(dOut[4]||'0');
    } catch(e) {}

    alertEngine.evaluateRules({
      cpu: { usage: cpuPct },
      mem: { pct: memPct },
      disk: { pct: diskPct }
    });
  } catch(e) { console.error('[Alert] 评估失败:', e.message); }
}, 30000);

http.createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log(`OpenClaw Monitor running at http://0.0.0.0:${PORT}`);
});
