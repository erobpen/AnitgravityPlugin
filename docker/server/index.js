const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const cors = require('cors');

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

// Start a new prompt session
app.post('/api/prompt', (req, res) => {
    const { text } = req.body;
    currentPrompt = text || 'New prompt';
    agents.clear();
    eventLog = [];
    sessionStartTime = Date.now();

    const event = { type: 'prompt_start', prompt: currentPrompt, timestamp: Date.now() };
    eventLog.push(event);
    broadcastEvent(event);
    broadcastState();

    res.json({ ok: true, prompt: currentPrompt });
});

// Create / update / remove an agent
app.post('/api/agent', (req, res) => {
    const { id, name, role, action, message, target, remove } = req.body;

    if (!id) {
        return res.status(400).json({ error: 'Agent id is required' });
    }

    if (remove) {
        agents.delete(id);
        const event = { type: 'agent_remove', agentId: id, timestamp: Date.now() };
        eventLog.push(event);
        broadcastEvent(event);
        broadcastState();
        return res.json({ ok: true, removed: id });
    }

    const existing = agents.get(id);
    const agent = {
        id,
        name: name || (existing && existing.name) || `Agent ${id}`,
        role: role || (existing && existing.role) || 'developer',
        action: action || (existing && existing.action) || 'idle',
        message: message !== undefined ? message : (existing && existing.message) || null,
        target: target !== undefined ? target : (existing && existing.target) || null,
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

    res.json({ ok: true, agent });
});

// Get current state snapshot
app.get('/api/state', (req, res) => {
    res.json(getState());
});

// Get event log
app.get('/api/events', (req, res) => {
    res.json({ events: eventLog });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Server ─────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('[WS] Client connected');
    // Send current state on connect
    ws.send(JSON.stringify({ type: 'state', data: getState() }));

    ws.on('close', () => {
        console.log('[WS] Client disconnected');
    });
});

const PORT = process.env.PORT || 3777;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🏢 Agent Visualizer server running on port ${PORT}`);
    console.log(`   REST API: http://0.0.0.0:${PORT}/api`);
    console.log(`   WebSocket: ws://0.0.0.0:${PORT}`);
});
