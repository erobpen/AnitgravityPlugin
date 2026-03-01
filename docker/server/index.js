const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const cors = require('cors');
const chokidar = require('chokidar');

const app = express();
app.use(cors());
app.use(express.json());

// Serve the office.html frontend
app.use(express.static(path.join(__dirname, 'public')));

// ── State ──────────────────────────────────────────────────────────────
let currentPrompt = null;
let agents = new Map();
let sessionStartTime = null;
let eventLog = [];

// Agent auto-removal timers
const agentTimers = new Map();
const AGENT_TTL = 15000; // agents disappear after 15s of inactivity

function showAgent(id, name, role, action, message, target) {
    const existing = agents.get(id);
    const agent = {
        id,
        name: name || (existing && existing.name) || 'Agent',
        role: role || (existing && existing.role) || 'Developer',
        action: action || 'coding',
        message: message || '',
        target: target || null,
        spawnedAt: (existing && existing.spawnedAt) || Date.now(),
        updatedAt: Date.now()
    };

    const isNew = !existing;
    agents.set(id, agent);

    const event = {
        type: isNew ? 'agent_spawn' : 'agent_update',
        agent: { ...agent },
        timestamp: Date.now()
    };
    eventLog.push(event);
    broadcastEvent(event);
    broadcastState();

    // Reset auto-removal timer
    if (agentTimers.has(id)) clearTimeout(agentTimers.get(id));
    agentTimers.set(id, setTimeout(() => {
        agents.delete(id);
        agentTimers.delete(id);
        const rmEvent = { type: 'agent_remove', agentId: id, timestamp: Date.now() };
        eventLog.push(rmEvent);
        broadcastEvent(rmEvent);
        broadcastState();
    }, AGENT_TTL));
}

function broadcastState() {
    const state = getState();
    const message = JSON.stringify({ type: 'state', data: state });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function broadcastEvent(event) {
    const message = JSON.stringify({ type: 'event', data: event });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function getState() {
    return {
        prompt: currentPrompt,
        agents: Array.from(agents.values()),
        sessionStartTime,
        eventCount: eventLog.length
    };
}

// ── REST API ───────────────────────────────────────────────────────────

app.post('/api/prompt', (req, res) => {
    const { text } = req.body;
    currentPrompt = text || 'New prompt';
    agents.clear();
    agentTimers.forEach(t => clearTimeout(t));
    agentTimers.clear();
    eventLog = [];
    sessionStartTime = Date.now();

    const event = { type: 'prompt_start', prompt: currentPrompt, timestamp: Date.now() };
    eventLog.push(event);
    broadcastEvent(event);
    broadcastState();

    res.json({ ok: true, prompt: currentPrompt });
});

app.post('/api/agent', (req, res) => {
    const { id, name, role, action, message, target, remove } = req.body;

    if (!id) {
        return res.status(400).json({ error: 'Agent id is required' });
    }

    if (remove) {
        agents.delete(id);
        if (agentTimers.has(id)) { clearTimeout(agentTimers.get(id)); agentTimers.delete(id); }
        const event = { type: 'agent_remove', agentId: id, timestamp: Date.now() };
        eventLog.push(event);
        broadcastEvent(event);
        broadcastState();
        return res.json({ ok: true, removed: id });
    }

    showAgent(id, name, role, action, message, target);
    res.json({ ok: true, agent: agents.get(id) });
});

app.get('/api/state', (req, res) => res.json(getState()));
app.get('/api/events', (req, res) => res.json({ events: eventLog }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── Server ─────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('[WS] Client connected');
    ws.send(JSON.stringify({ type: 'state', data: getState() }));
    ws.on('close', () => console.log('[WS] Client disconnected'));
});

// ── FILESYSTEM WATCHER ─────────────────────────────────────────────────
// Watches mounted volumes to detect all Antigravity agent activity
// ────────────────────────────────────────────────────────────────────────

const WORKSPACE_DIR = process.env.WATCH_WORKSPACE || '/workspace';
const BRAIN_DIR = process.env.WATCH_BRAIN || '/brain';

// Debounce map to prevent floods
const debounce = new Map();
function debounced(key, ms, fn) {
    if (debounce.has(key)) clearTimeout(debounce.get(key));
    debounce.set(key, setTimeout(() => { debounce.delete(key); fn(); }, ms));
}

function getAgentForFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const base = path.basename(filePath);
    const dir = path.dirname(filePath);

    // Brain directory = architect activity
    if (filePath.startsWith(BRAIN_DIR)) {
        if (ext === '.md') return { id: 'brain-write', name: 'Alice', role: 'Architect', action: 'coding' };
        if (ext === '.png' || ext === '.webp') return { id: 'brain-screenshot', name: 'Alice', role: 'Architect', action: 'reviewing' };
        return { id: 'brain-misc', name: 'Alice', role: 'Architect', action: 'thinking' };
    }

    // Source code files
    if (['.ts', '.js', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.cs'].includes(ext)) {
        return { id: 'dev-code', name: 'Bob', role: 'Developer', action: 'coding' };
    }

    // Config / package files
    if (['.json', '.yaml', '.yml', '.toml', '.env', '.ini'].includes(ext) || base === 'Dockerfile') {
        return { id: 'dev-config', name: 'Dave', role: 'DevOps', action: 'coding' };
    }

    // Frontend files
    if (['.html', '.css', '.scss', '.less', '.svg'].includes(ext)) {
        return { id: 'dev-frontend', name: 'Frank', role: 'Designer', action: 'coding' };
    }

    // Documentation
    if (['.md', '.txt', '.rst', '.adoc'].includes(ext)) {
        return { id: 'dev-docs', name: 'Eve', role: 'PM', action: 'coding' };
    }

    // Test files
    if (base.includes('test') || base.includes('spec') || dir.includes('test')) {
        return { id: 'dev-test', name: 'Carol', role: 'Tester', action: 'reviewing' };
    }

    return { id: 'dev-general', name: 'Bob', role: 'Developer', action: 'coding' };
}

function startFileWatcher() {
    const dirs = [];

    // Check if workspace mount exists
    try {
        const fs = require('fs');
        if (fs.existsSync(WORKSPACE_DIR)) {
            dirs.push(WORKSPACE_DIR);
            console.log(`[Watcher] Watching workspace: ${WORKSPACE_DIR}`);
        }
    } catch { }

    // Check if brain mount exists
    try {
        const fs = require('fs');
        if (fs.existsSync(BRAIN_DIR)) {
            dirs.push(BRAIN_DIR);
            console.log(`[Watcher] Watching brain: ${BRAIN_DIR}`);
        }
    } catch { }

    if (dirs.length === 0) {
        console.log('[Watcher] No directories to watch — volumes not mounted');
        return;
    }

    const watcher = chokidar.watch(dirs, {
        persistent: true,
        ignoreInitial: true,
        ignored: [
            '**/node_modules/**',
            '**/.git/**',
            '**/out/**',
            '**/*.vsix',
            '**/dist/**'
        ],
        usePolling: true,       // Required for Docker volume watch on Windows
        interval: 500,          // Poll every 500ms
        awaitWriteFinish: {
            stabilityThreshold: 300,
            pollInterval: 100
        }
    });

    // Set the initial prompt
    if (!currentPrompt) {
        currentPrompt = 'Antigravity — Live Workspace Activity';
        sessionStartTime = Date.now();
        broadcastState();
    }

    watcher.on('change', (filePath) => {
        const base = path.basename(filePath);
        const agent = getAgentForFile(filePath);
        debounced(`change-${agent.id}`, 400, () => {
            console.log(`[Watcher] Changed: ${base}`);
            showAgent(agent.id, agent.name, agent.role, agent.action,
                `Editing ${base}`);
        });
    });

    watcher.on('add', (filePath) => {
        const base = path.basename(filePath);
        const agent = getAgentForFile(filePath);
        debounced(`add-${agent.id}`, 400, () => {
            console.log(`[Watcher] Created: ${base}`);
            showAgent('fs-create', 'Eve', 'PM', 'talking',
                `New file: ${base}`, agent.name);
        });
    });

    watcher.on('unlink', (filePath) => {
        const base = path.basename(filePath);
        debounced(`del-${base}`, 400, () => {
            console.log(`[Watcher] Deleted: ${base}`);
            showAgent('fs-delete', 'Eve', 'PM', 'thinking',
                `Deleted: ${base}`);
        });
    });

    watcher.on('error', (err) => {
        console.error('[Watcher] Error:', err.message);
    });

    console.log('[Watcher] File system watcher started — all changes will appear in office');
}

// ── Start ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3777;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🏢 Agent Visualizer server running on port ${PORT}`);
    console.log(`   REST API: http://0.0.0.0:${PORT}/api`);
    console.log(`   WebSocket: ws://0.0.0.0:${PORT}`);

    // Start the filesystem watcher after server is up
    startFileWatcher();
});
