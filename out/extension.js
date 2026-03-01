"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const http = __importStar(require("http"));
const PIXEL_ART_SERVER = 'http://localhost:3777';
let currentPanel;
let wsConnection;
// Debounce timers for activity detection
let editDebounce;
let terminalDebounce;
let diagnosticDebounce;
// Track active agents so we can clean up
const activeAgents = new Set();
// ──────────────────────────────────────────────
// HTTP helper to post events to Docker API
// ──────────────────────────────────────────────
async function postAgentEvent(endpoint, data) {
    return new Promise((resolve) => {
        try {
            const payload = JSON.stringify(data);
            const url = new URL(endpoint, PIXEL_ART_SERVER);
            const req = http.request({
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            }, (res) => {
                res.on('data', () => { });
                res.on('end', () => resolve());
            });
            req.on('error', () => resolve());
            req.write(payload);
            req.end();
        }
        catch {
            resolve();
        }
    });
}
async function spawnAgent(id, name, role, action, message, target) {
    activeAgents.add(id);
    await postAgentEvent('/api/agent', { id, name, role, action, message, target });
}
async function removeAgent(id) {
    if (activeAgents.has(id)) {
        activeAgents.delete(id);
        await postAgentEvent('/api/agent', { id, remove: true });
    }
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// ──────────────────────────────────────────────
// REAL-TIME WORKSPACE ACTIVITY MONITOR
// ──────────────────────────────────────────────
function startRealtimeMonitor(context) {
    // 1. FILE EDITS → "Developer" agent codes
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length === 0)
            return;
        const fileName = path.basename(e.document.fileName);
        // Ignore output channels, git internals, settings
        if (fileName.startsWith('extension-output') || e.document.uri.scheme !== 'file')
            return;
        if (editDebounce)
            clearTimeout(editDebounce);
        editDebounce = setTimeout(async () => {
            const lang = e.document.languageId;
            const roleMap = {
                'typescript': 'Developer', 'javascript': 'Developer',
                'python': 'Developer', 'json': 'Analyst',
                'html': 'Designer', 'css': 'Designer',
                'markdown': 'PM', 'yaml': 'DevOps',
                'dockerfile': 'DevOps'
            };
            const role = roleMap[lang] || 'Developer';
            await spawnAgent('dev-edit', getNameForRole(role), role, 'coding', `Editing ${fileName}`);
            // Auto-remove after 8 seconds of inactivity
            setTimeout(() => removeAgent('dev-edit'), 8000);
        }, 500); // debounce 500ms
    }));
    // 2. FILE SAVES → brief "reviewing" action
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
        const fileName = path.basename(doc.fileName);
        if (doc.uri.scheme !== 'file')
            return;
        await spawnAgent('dev-save', 'Carol', 'Tester', 'reviewing', `Saved ${fileName} — checking for issues...`);
        setTimeout(() => removeAgent('dev-save'), 5000);
    }));
    // 3. TERMINAL ACTIVITY → "DevOps" agent runs commands
    context.subscriptions.push(vscode.window.onDidOpenTerminal(async (terminal) => {
        await spawnAgent('ops-terminal', 'Dave', 'DevOps', 'coding', `Terminal opened: ${terminal.name}`);
        setTimeout(() => removeAgent('ops-terminal'), 6000);
    }));
    context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(async (terminal) => {
        if (!terminal)
            return;
        if (terminalDebounce)
            clearTimeout(terminalDebounce);
        terminalDebounce = setTimeout(async () => {
            await spawnAgent('ops-terminal', 'Dave', 'DevOps', 'coding', `Running commands in ${terminal.name}...`);
            setTimeout(() => removeAgent('ops-terminal'), 6000);
        }, 300);
    }));
    // 4. DIAGNOSTICS (errors/warnings) → "Tester" reviews
    context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(async (e) => {
        if (diagnosticDebounce)
            clearTimeout(diagnosticDebounce);
        diagnosticDebounce = setTimeout(async () => {
            let totalErrors = 0;
            let totalWarnings = 0;
            for (const uri of e.uris) {
                const diags = vscode.languages.getDiagnostics(uri);
                totalErrors += diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
                totalWarnings += diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;
            }
            if (totalErrors > 0) {
                await spawnAgent('tester-diag', 'Carol', 'Tester', 'reviewing', `Found ${totalErrors} error(s) and ${totalWarnings} warning(s)!`);
            }
            else if (totalWarnings > 0) {
                await spawnAgent('tester-diag', 'Carol', 'Tester', 'thinking', `${totalWarnings} warning(s) — reviewing...`);
            }
            else {
                await spawnAgent('tester-diag', 'Carol', 'Tester', 'talking', `All clear! No errors. ✅`, 'Bob');
            }
            setTimeout(() => removeAgent('tester-diag'), 6000);
        }, 1000);
    }));
    // 5. ACTIVE EDITOR CHANGE → "Architect" navigates codebase
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (!editor || editor.document.uri.scheme !== 'file')
            return;
        const fileName = path.basename(editor.document.fileName);
        await spawnAgent('arch-nav', 'Alice', 'Architect', 'thinking', `Reviewing ${fileName}...`);
        setTimeout(() => removeAgent('arch-nav'), 5000);
    }));
    // 6. FILE CREATION/DELETION → "PM" tracks progress
    context.subscriptions.push(vscode.workspace.onDidCreateFiles(async (e) => {
        const names = e.files.map(f => path.basename(f.fsPath)).join(', ');
        await spawnAgent('pm-files', 'Eve', 'PM', 'talking', `New file(s) created: ${names}`, 'Bob');
        setTimeout(() => removeAgent('pm-files'), 5000);
    }));
    context.subscriptions.push(vscode.workspace.onDidDeleteFiles(async (e) => {
        const names = e.files.map(f => path.basename(f.fsPath)).join(', ');
        await spawnAgent('pm-files', 'Eve', 'PM', 'thinking', `File(s) deleted: ${names}`);
        setTimeout(() => removeAgent('pm-files'), 5000);
    }));
    console.log('[AgentViz] Real-time workspace monitor started');
}
function getNameForRole(role) {
    const names = {
        'Developer': 'Bob', 'Architect': 'Alice', 'Tester': 'Carol',
        'PM': 'Eve', 'Designer': 'Frank', 'Analyst': 'Dave', 'DevOps': 'Dave'
    };
    return names[role] || 'Bob';
}
// ──────────────────────────────────────────────
// EXTENSION ACTIVATION
// ──────────────────────────────────────────────
function activate(context) {
    console.log('Agent Visualizer extension activated');
    // 1. Register Webview Panel Command
    const openCmd = vscode.commands.registerCommand('agentViz.openPanel', () => openPanel(context));
    context.subscriptions.push(openCmd);
    // 2. Register Chat Participant (@visualize)
    const chatHandler = async (request, contextInfo, stream, token) => {
        vscode.commands.executeCommand('agentViz.openPanel');
        await postAgentEvent('/api/prompt', { text: request.prompt });
        stream.progress('Planning the task...');
        try {
            const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
            if (!model) {
                stream.markdown('No language model found.');
                return { errorDetails: { message: 'Model not found' } };
            }
            const prompt = `
You are a development team orchestrator. Break the user's task into 4-6 sequential steps.
For each step, assign one of these roles: architect, developer, tester, pm.
Respond in valid JSON only, no markdown blocks:
[{"role":"architect","name":"Alice","action":"thinking","message":"Planning..."}]
Actions: thinking, talking, coding, reviewing, break.

User Task: ${request.prompt}`;
            const userMessage = vscode.LanguageModelChatMessage.User(prompt);
            const response = await model.sendRequest([userMessage], {}, token);
            let aiOutput = '';
            for await (const chunk of response.text) {
                aiOutput += chunk;
            }
            let plan = [];
            try {
                plan = JSON.parse(aiOutput.replace(/```json/g, '').replace(/```/g, '').trim());
            }
            catch {
                plan = [
                    { role: 'architect', name: 'Alice', action: 'thinking', message: `Analyzing: ${request.prompt}` },
                    { role: 'developer', name: 'Bob', action: 'coding', message: 'Implementing...' },
                    { role: 'tester', name: 'Carol', action: 'reviewing', message: 'Testing...' }
                ];
            }
            stream.markdown('**Execution Plan:**\n\n');
            for (const step of plan) {
                stream.markdown(`- **${step.name} (${step.role})**: ${step.message}\n`);
            }
            stream.progress('Agents working in the office...');
            let i = 1;
            for (const step of plan) {
                if (token.isCancellationRequested)
                    break;
                await spawnAgent(`chat-${i}`, step.name, step.role, step.action, step.message, step.target);
                await sleep(3000);
                i++;
            }
            for (let j = 1; j < i; j++) {
                await removeAgent(`chat-${j}`);
                await sleep(500);
            }
            stream.markdown('\n\n✅ Task complete!');
            return {};
        }
        catch (err) {
            stream.markdown(`Error: ${err.message}`);
            return { errorDetails: { message: err.message } };
        }
    };
    const participant = vscode.chat.createChatParticipant('agentViz.participant', chatHandler);
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    context.subscriptions.push(participant);
    // 3. START REAL-TIME MONITOR — watches file edits, terminal, diagnostics, etc.
    startRealtimeMonitor(context);
    // Send initial prompt to visualizer
    postAgentEvent('/api/prompt', { text: 'Antigravity IDE — live workspace activity' });
}
// ──────────────────────────────────────────────
// WEBVIEW PANEL
// ──────────────────────────────────────────────
function openPanel(context) {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
        return;
    }
    currentPanel = vscode.window.createWebviewPanel('agentVisualizer', '🏢 Agent Office', vscode.ViewColumn.One, {
        enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
    });
    const htmlPath = path.join(context.extensionPath, 'media', 'office.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    const mediaUri = currentPanel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media')));
    html = html.replace(/{{mediaUri}}/g, mediaUri.toString());
    currentPanel.webview.html = html;
    connectToServer(currentPanel);
    currentPanel.onDidDispose(() => {
        currentPanel = undefined;
        if (wsConnection) {
            wsConnection.close();
            wsConnection = undefined;
        }
    }, null, context.subscriptions);
}
function connectToServer(panel) {
    try {
        const WebSocket = require('ws');
        if (wsConnection)
            wsConnection.close();
        wsConnection = new WebSocket('ws://localhost:3777');
        wsConnection.on('open', () => panel.webview.postMessage({ type: 'connection', status: 'connected' }));
        wsConnection.on('message', (data) => {
            try {
                panel.webview.postMessage(JSON.parse(data.toString()));
            }
            catch { }
        });
        wsConnection.on('close', () => {
            panel.webview.postMessage({ type: 'connection', status: 'disconnected' });
            setTimeout(() => { if (currentPanel)
                connectToServer(panel); }, 3000);
        });
        wsConnection.on('error', (err) => {
            panel.webview.postMessage({ type: 'connection', status: 'error', error: err.message });
        });
    }
    catch (err) {
        panel.webview.postMessage({ type: 'connection', status: 'error', error: err.message });
    }
}
function deactivate() {
    // Clean up all active agents
    for (const id of activeAgents) {
        postAgentEvent('/api/agent', { id, remove: true });
    }
    if (wsConnection)
        wsConnection.close();
}
//# sourceMappingURL=extension.js.map