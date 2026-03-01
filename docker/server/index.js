const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const cors = require('cors');
const chokidar = require('chokidar');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

// ── State ──────────────────────────────────────────────────────────────
let currentPrompt = null;
let agents = new Map();
let sessionStartTime = null;
let eventLog = [];
let chatHistory = []; // Persists chat messages for replay on reconnect

const agentTimers = new Map();
const AGENT_TTL = 15000;

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

    if (agentTimers.has(id)) clearTimeout(agentTimers.get(id));
    agentTimers.set(id, setTimeout(() => {
        agents.delete(id);
        agentTimers.delete(id);
        broadcastEvent({ type: 'agent_remove', agentId: id, timestamp: Date.now() });
        broadcastState();
    }, AGENT_TTL));
}

function broadcastState() {
    const state = getState();
    const msg = JSON.stringify({ type: 'state', data: state });
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function broadcastEvent(event) {
    const msg = JSON.stringify({ type: 'event', data: event });
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
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
    broadcastEvent({ type: 'prompt_start', prompt: currentPrompt, timestamp: Date.now() });
    broadcastState();
    res.json({ ok: true });
});

app.post('/api/agent', (req, res) => {
    const { id, name, role, action, message, target, remove } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    if (remove) {
        agents.delete(id);
        if (agentTimers.has(id)) { clearTimeout(agentTimers.get(id)); agentTimers.delete(id); }
        broadcastEvent({ type: 'agent_remove', agentId: id, timestamp: Date.now() });
        broadcastState();
        return res.json({ ok: true });
    }
    showAgent(id, name, role, action, message, target);
    res.json({ ok: true, agent: agents.get(id) });
});

// Chat message endpoint — shows text in the chat log panel
app.post('/api/chat', (req, res) => {
    const { role, agent, text } = req.body;
    const chatRole = role || 'agent';
    const agentName = agent || (chatRole === 'user' ? 'You' : 'Antigravity');

    // Show agent in office
    const isUser = chatRole === 'user';
    showAgent(
        isUser ? 'chat-user' : 'chat-agent',
        agentName,
        isUser ? 'PM' : 'Architect',
        isUser ? 'talking' : 'thinking',
        (text || '').substring(0, 100),
        isUser ? 'Antigravity' : undefined
    );

    // Broadcast to chat log panel
    // Store in history for replay on reconnect
    const chatMsg = {
        type: 'chat_message',
        role: chatRole,
        agent: agentName,
        text: text || '',
        timestamp: Date.now()
    };
    chatHistory.push(chatMsg);
    broadcastEvent(chatMsg);

    res.json({ ok: true });
});

// Batch post chat messages (for posting entire conversation)
app.post('/api/chatlog', (req, res) => {
    const { messages } = req.body;
    if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });

    messages.forEach((msg, i) => {
        const chatMsg = {
            type: 'chat_message',
            role: msg.role || 'agent',
            agent: msg.agent || 'Agent',
            text: msg.text || '',
            timestamp: msg.timestamp || Date.now()
        };
        chatHistory.push(chatMsg);
        setTimeout(() => broadcastEvent(chatMsg), i * 80);
    });

    res.json({ ok: true, count: messages.length });
});

// GET chat history
app.get('/api/chatlog', (req, res) => {
    res.json({ messages: chatHistory });
});

app.get('/api/state', (req, res) => res.json(getState()));
app.get('/api/events', (req, res) => res.json({ events: eventLog }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── Server ─────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('[WS] Client connected');
    // Send current state
    ws.send(JSON.stringify({ type: 'state', data: getState() }));
    // Replay all chat history
    chatHistory.forEach((msg, i) => {
        setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'event', data: msg }));
            }
        }, i * 30);
    });
    ws.on('close', () => console.log('[WS] Client disconnected'));
});

// ── FILE CONTENT READER ────────────────────────────────────────────────
// Reads the last few meaningful lines of a file to use as bubble text
function readFileExcerpt(filePath, maxChars) {
    maxChars = maxChars || 120;
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        // Get last meaningful lines
        const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) return null;

        // Take the last 3 non-empty lines, join and truncate
        const excerpt = lines.slice(-3).join(' ').substring(0, maxChars);
        return excerpt || null;
    } catch {
        return null;
    }
}

// ── FILESYSTEM WATCHER ─────────────────────────────────────────────────
const WORKSPACE_DIR = process.env.WATCH_WORKSPACE || '/workspace';
const BRAIN_DIR = process.env.WATCH_BRAIN || '/brain';

const debounceMap = new Map();
function debounced(key, ms, fn) {
    if (debounceMap.has(key)) clearTimeout(debounceMap.get(key));
    debounceMap.set(key, setTimeout(() => { debounceMap.delete(key); fn(); }, ms));
}

function getAgentForFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const base = path.basename(filePath);
    const dir = path.dirname(filePath);

    if (filePath.startsWith(BRAIN_DIR)) {
        if (ext === '.md')
            return { id: 'brain-write', name: 'Alice', role: 'Architect', action: 'coding' };
        if (ext === '.png' || ext === '.webp')
            return { id: 'brain-media', name: 'Alice', role: 'Architect', action: 'reviewing' };
        return { id: 'brain-misc', name: 'Alice', role: 'Architect', action: 'thinking' };
    }

    if (['.ts', '.js', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.cs'].includes(ext))
        return { id: 'dev-code', name: 'Bob', role: 'Developer', action: 'coding' };

    if (['.json', '.yaml', '.yml', '.toml', '.env'].includes(ext) || base === 'Dockerfile')
        return { id: 'dev-config', name: 'Dave', role: 'DevOps', action: 'coding' };

    if (['.html', '.css', '.scss', '.less', '.svg'].includes(ext))
        return { id: 'dev-frontend', name: 'Frank', role: 'Designer', action: 'coding' };

    if (['.md', '.txt', '.rst'].includes(ext))
        return { id: 'dev-docs', name: 'Eve', role: 'PM', action: 'coding' };

    if (base.includes('test') || base.includes('spec') || dir.includes('test'))
        return { id: 'dev-test', name: 'Carol', role: 'Tester', action: 'reviewing' };

    return { id: 'dev-general', name: 'Bob', role: 'Developer', action: 'coding' };
}

function startFileWatcher() {
    const dirs = [];
    try { if (fs.existsSync(WORKSPACE_DIR)) { dirs.push(WORKSPACE_DIR); console.log(`[Watcher] Watching workspace: ${WORKSPACE_DIR}`); } } catch { }
    try { if (fs.existsSync(BRAIN_DIR)) { dirs.push(BRAIN_DIR); console.log(`[Watcher] Watching brain: ${BRAIN_DIR}`); } } catch { }

    if (dirs.length === 0) {
        console.log('[Watcher] No directories to watch');
        return;
    }

    const watcher = chokidar.watch(dirs, {
        persistent: true,
        ignoreInitial: true,
        ignored: ['**/node_modules/**', '**/.git/**', '**/out/**', '**/*.vsix', '**/dist/**'],
        usePolling: true,
        interval: 500,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
    });

    if (!currentPrompt) {
        currentPrompt = 'Antigravity — Live Workspace Activity';
        sessionStartTime = Date.now();
        broadcastState();
    }

    watcher.on('change', (filePath) => {
        const base = path.basename(filePath);
        // Skip the chat bridge file — handled separately
        if (base === '_chat_bridge.jsonl') return;
        const agent = getAgentForFile(filePath);
        debounced(`change-${agent.id}`, 400, () => {
            const excerpt = readFileExcerpt(filePath);
            const bubbleText = excerpt
                ? `📝 ${base}: ${excerpt}`
                : `Editing ${base}`;
            console.log(`[Watcher] Changed: ${base}`);
            showAgent(agent.id, agent.name, agent.role, agent.action, bubbleText);
            // Also push to chat log
            const chatMsg = {
                type: 'chat_message',
                role: 'tool',
                agent: agent.name + ' (' + agent.role + ')',
                text: bubbleText,
                timestamp: Date.now()
            };
            chatHistory.push(chatMsg);
            broadcastEvent(chatMsg);
        });
    });

    watcher.on('add', (filePath) => {
        const base = path.basename(filePath);
        if (base === '_chat_bridge.jsonl') return;
        const agent = getAgentForFile(filePath);
        debounced(`add-${agent.id}`, 400, () => {
            const excerpt = readFileExcerpt(filePath);
            const bubbleText = excerpt
                ? `✨ New ${base}: ${excerpt}`
                : `New file: ${base}`;
            console.log(`[Watcher] Created: ${base}`);
            showAgent('fs-create', 'Eve', 'PM', 'talking', bubbleText, agent.name);
            const chatMsg = {
                type: 'chat_message',
                role: 'tool',
                agent: 'Eve (PM)',
                text: bubbleText,
                timestamp: Date.now()
            };
            chatHistory.push(chatMsg);
            broadcastEvent(chatMsg);
        });
    });

    watcher.on('unlink', (filePath) => {
        const base = path.basename(filePath);
        if (base === '_chat_bridge.jsonl') return;
        debounced(`del-${base}`, 400, () => {
            console.log(`[Watcher] Deleted: ${base}`);
            showAgent('fs-delete', 'Eve', 'PM', 'thinking', `🗑️ Deleted: ${base}`);
            const chatMsg = {
                type: 'chat_message',
                role: 'tool',
                agent: 'Eve (PM)',
                text: `🗑️ Deleted: ${base}`,
                timestamp: Date.now()
            };
            chatHistory.push(chatMsg);
            broadcastEvent(chatMsg);
        });
    });

    watcher.on('error', (err) => console.error('[Watcher] Error:', err.message));
    console.log('[Watcher] File system watcher started — content will appear in office bubbles');

    // ── CHAT BRIDGE FILE WATCHER ──────────────────────────────────────
    // Watches _chat_bridge.jsonl for new lines appended by the agent.
    // Each line is a JSON object: {"role":"user|agent","agent":"Name","text":"..."}
    // Reads only NEW lines by tracking byte offset.
    const BRIDGE_FILE = path.join(WORKSPACE_DIR, '_chat_bridge.jsonl');
    let bridgeOffset = 0;

    // Initialize offset to current file size (skip existing content on startup)
    try {
        if (fs.existsSync(BRIDGE_FILE)) {
            bridgeOffset = fs.statSync(BRIDGE_FILE).size;
            console.log(`[Bridge] Found existing bridge file, offset=${bridgeOffset}`);
        }
    } catch { }

    function processBridgeFile() {
        try {
            const stat = fs.statSync(BRIDGE_FILE);
            if (stat.size <= bridgeOffset) return;

            // Read only the new bytes
            const fd = fs.openSync(BRIDGE_FILE, 'r');
            const buf = Buffer.alloc(stat.size - bridgeOffset);
            fs.readSync(fd, buf, 0, buf.length, bridgeOffset);
            fs.closeSync(fd);
            bridgeOffset = stat.size;

            const newContent = buf.toString('utf8');
            const lines = newContent.split('\n').filter(l => l.trim().length > 0);

            for (const line of lines) {
                try {
                    const msg = JSON.parse(line);
                    const chatRole = msg.role || 'agent';
                    const agentName = msg.agent || (chatRole === 'user' ? 'You' : 'Antigravity');
                    const text = msg.text || '';

                    // Show agent in office
                    const isUser = chatRole === 'user';
                    showAgent(
                        isUser ? 'chat-user' : 'chat-agent',
                        agentName,
                        isUser ? 'PM' : 'Architect',
                        isUser ? 'talking' : 'thinking',
                        text.substring(0, 100),
                        isUser ? 'Antigravity' : undefined
                    );

                    // Push to chat log
                    const chatMsg = {
                        type: 'chat_message',
                        role: chatRole,
                        agent: agentName,
                        text: text,
                        timestamp: Date.now()
                    };
                    chatHistory.push(chatMsg);
                    broadcastEvent(chatMsg);

                    console.log(`[Bridge] ${agentName}: ${text.substring(0, 60)}...`);
                } catch (parseErr) {
                    console.log(`[Bridge] Skipping malformed line: ${line.substring(0, 50)}`);
                }
            }
        } catch (err) {
            // File doesn't exist yet, that's fine
        }
    }

    // Watch the bridge file specifically
    const bridgeWatcher = chokidar.watch(BRIDGE_FILE, {
        persistent: true,
        ignoreInitial: true,
        usePolling: true,
        interval: 300,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 }
    });

    bridgeWatcher.on('add', () => processBridgeFile());
    bridgeWatcher.on('change', () => processBridgeFile());
    bridgeWatcher.on('error', () => { }); // silently ignore if file doesn't exist yet

    console.log(`[Bridge] Watching for chat bridge file: ${BRIDGE_FILE}`);
}

// ── Start ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3777;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🏢 Agent Visualizer server running on port ${PORT}`);
    startFileWatcher();
});

