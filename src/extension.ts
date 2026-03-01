import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';

const PIXEL_ART_SERVER = 'http://localhost:3777';
const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

let currentPanel: vscode.WebviewPanel | undefined;
let wsConnection: any;

// Active agent tracking with auto-expire
const agentTimers = new Map<string, NodeJS.Timeout>();
const AGENT_LIFETIME = 12000; // agents stay visible 12s after last update

// ──────────────────────────────────────────────
// HTTP helper — fire-and-forget to Docker API
// ──────────────────────────────────────────────
function postAgentEvent(endpoint: string, data: any): void {
    try {
        const payload = JSON.stringify(data);
        const url = new URL(endpoint, PIXEL_ART_SERVER);
        const req = http.request({
            hostname: url.hostname, port: url.port, path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => { res.on('data', () => { }); res.on('end', () => { }); });
        req.on('error', () => { }); // silently ignore if Docker is offline
        req.write(payload);
        req.end();
    } catch { /* noop */ }
}

function showAgent(id: string, name: string, role: string, action: string, message: string, target?: string) {
    // Clear any pending removal
    const existing = agentTimers.get(id);
    if (existing) clearTimeout(existing);

    // Post the agent event
    postAgentEvent('/api/agent', { id, name, role, action, message, target });

    // Schedule auto-removal
    agentTimers.set(id, setTimeout(() => {
        postAgentEvent('/api/agent', { id, remove: true });
        agentTimers.delete(id);
    }, AGENT_LIFETIME));
}

function removeAgent(id: string) {
    const existing = agentTimers.get(id);
    if (existing) clearTimeout(existing);
    agentTimers.delete(id);
    postAgentEvent('/api/agent', { id, remove: true });
}

// ──────────────────────────────────────────────
// COMPREHENSIVE REAL-TIME MONITOR
// No filtering — captures EVERYTHING
// ──────────────────────────────────────────────
function startRealtimeMonitor(context: vscode.ExtensionContext) {

    // ─── 1. EVERY TEXT CHANGE (no filtering) ───
    let editBatch = 0;
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.contentChanges.length === 0) return;
            editBatch++;
            const batch = editBatch;
            // Debounce to 300ms to group rapid edits
            setTimeout(() => {
                if (batch !== editBatch) return;
                const fileName = path.basename(e.document.fileName);
                const ext = path.extname(fileName).toLowerCase();
                const lang = e.document.languageId;
                const lines = e.contentChanges.reduce((sum, c) => sum + c.text.split('\n').length, 0);

                // Map language to role
                let role = 'Developer';
                let name = 'Bob';
                if (['json', 'yaml', 'yml', 'toml'].includes(ext.replace('.', ''))) { role = 'Analyst'; name = 'Dave'; }
                if (['html', 'css', 'scss', 'less'].includes(ext.replace('.', ''))) { role = 'Designer'; name = 'Frank'; }
                if (['md', 'txt', 'rst'].includes(ext.replace('.', ''))) { role = 'PM'; name = 'Eve'; }
                if (lang === 'dockerfile' || ext === '.yml' || ext === '.yaml') { role = 'DevOps'; name = 'Dave'; }

                showAgent('edit-agent', name, role, 'coding',
                    `Editing ${fileName} (+${lines} lines)`);
            }, 300);
        })
    );

    // ─── 2. EVERY FILE SAVE ───
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            const fileName = path.basename(doc.fileName);
            showAgent('save-agent', 'Carol', 'Tester', 'reviewing',
                `Saved ${fileName} — verifying...`);
        })
    );

    // ─── 3. EVERY FILE OPEN ───
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
            const fileName = path.basename(doc.fileName);
            // Show architect looking at files
            showAgent('read-agent', 'Alice', 'Architect', 'thinking',
                `Reading ${fileName}...`);
        })
    );

    // ─── 4. EVERY EDITOR SWITCH ───
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!editor) return;
            const fileName = path.basename(editor.document.fileName);
            showAgent('nav-agent', 'Alice', 'Architect', 'thinking',
                `Navigating to ${fileName}`);
        })
    );

    // ─── 5. EVERY SELECTION CHANGE (cursor movement) ───
    let selBatch = 0;
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection((e) => {
            selBatch++;
            const batch = selBatch;
            setTimeout(() => {
                if (batch !== selBatch) return;
                const line = e.selections[0]?.active.line;
                const fileName = path.basename(e.textEditor.document.fileName);
                if (line !== undefined) {
                    showAgent('cursor-agent', 'Alice', 'Architect', 'reviewing',
                        `Inspecting ${fileName}:${line + 1}`);
                }
            }, 800); // debounce cursor to 800ms
        })
    );

    // ─── 6. EVERY TERMINAL EVENT ───
    context.subscriptions.push(
        vscode.window.onDidOpenTerminal((terminal) => {
            showAgent('term-agent', 'Dave', 'DevOps', 'coding',
                `Terminal opened: ${terminal.name}`);
        })
    );
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal((terminal) => {
            showAgent('term-agent', 'Dave', 'DevOps', 'thinking',
                `Terminal closed: ${terminal.name}`);
        })
    );
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTerminal((terminal) => {
            if (!terminal) return;
            showAgent('term-agent', 'Dave', 'DevOps', 'coding',
                `Running commands in ${terminal.name}...`);
        })
    );

    // ─── 7. EVERY DIAGNOSTIC CHANGE (errors, warnings, info) ───
    context.subscriptions.push(
        vscode.languages.onDidChangeDiagnostics((e) => {
            let errors = 0, warnings = 0, infos = 0;
            for (const uri of e.uris) {
                const diags = vscode.languages.getDiagnostics(uri);
                errors += diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
                warnings += diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;
                infos += diags.filter(d => d.severity === vscode.DiagnosticSeverity.Information).length;
            }
            if (errors > 0) {
                showAgent('diag-agent', 'Carol', 'Tester', 'reviewing',
                    `⚠️ ${errors} error(s), ${warnings} warning(s)!`);
            } else if (warnings > 0) {
                showAgent('diag-agent', 'Carol', 'Tester', 'thinking',
                    `${warnings} warning(s) detected...`);
            } else {
                showAgent('diag-agent', 'Carol', 'Tester', 'talking',
                    `All clear! No issues. ✅`, 'Bob');
            }
        })
    );

    // ─── 8. EVERY FILE CREATE / DELETE / RENAME ───
    context.subscriptions.push(
        vscode.workspace.onDidCreateFiles((e) => {
            const names = e.files.map(f => path.basename(f.fsPath)).join(', ');
            showAgent('fs-agent', 'Eve', 'PM', 'talking',
                `New: ${names}`, 'Bob');
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidDeleteFiles((e) => {
            const names = e.files.map(f => path.basename(f.fsPath)).join(', ');
            showAgent('fs-agent', 'Eve', 'PM', 'thinking',
                `Deleted: ${names}`);
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidRenameFiles((e) => {
            const renames = e.files.map(f =>
                `${path.basename(f.oldUri.fsPath)} → ${path.basename(f.newUri.fsPath)}`).join(', ');
            showAgent('fs-agent', 'Eve', 'PM', 'talking',
                `Renamed: ${renames}`, 'Alice');
        })
    );

    // ─── 9. WORKSPACE FOLDER CHANGES ───
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders((e) => {
            if (e.added.length > 0) {
                showAgent('ws-agent', 'Eve', 'PM', 'talking',
                    `Project opened: ${e.added.map(f => f.name).join(', ')}`, 'Alice');
            }
            if (e.removed.length > 0) {
                showAgent('ws-agent', 'Eve', 'PM', 'thinking',
                    `Project closed: ${e.removed.map(f => f.name).join(', ')}`);
            }
        })
    );

    // ─── 10. CONFIGURATION CHANGES ───
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(() => {
            showAgent('config-agent', 'Dave', 'DevOps', 'coding',
                `Settings changed`);
        })
    );

    // ─── 11. BRAIN DIRECTORY WATCHER ───
    // Watches Antigravity conversation artifacts for real-time agent activity
    try {
        if (fs.existsSync(BRAIN_DIR)) {
            const brainWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(BRAIN_DIR), '**/*')
            );

            brainWatcher.onDidCreate((uri) => {
                const fileName = path.basename(uri.fsPath);
                const ext = path.extname(fileName).toLowerCase();
                if (ext === '.png' || ext === '.webp') {
                    showAgent('brain-agent', 'Alice', 'Architect', 'reviewing',
                        `Screenshot captured: ${fileName}`);
                } else if (ext === '.md') {
                    showAgent('brain-agent', 'Eve', 'PM', 'coding',
                        `Writing artifact: ${fileName}`);
                } else {
                    showAgent('brain-agent', 'Alice', 'Architect', 'thinking',
                        `Brain activity: ${fileName}`);
                }
            });

            brainWatcher.onDidChange((uri) => {
                const fileName = path.basename(uri.fsPath);
                showAgent('brain-agent', 'Alice', 'Architect', 'coding',
                    `Updating: ${fileName}`);
            });

            brainWatcher.onDidDelete((uri) => {
                const fileName = path.basename(uri.fsPath);
                showAgent('brain-agent', 'Alice', 'Architect', 'thinking',
                    `Removed: ${fileName}`);
            });

            context.subscriptions.push(brainWatcher);
        }
    } catch { /* brain dir may not exist yet */ }

    // ─── 12. TASK EXECUTION EVENTS ───
    context.subscriptions.push(
        vscode.tasks.onDidStartTask((e) => {
            showAgent('task-agent', 'Dave', 'DevOps', 'coding',
                `Task started: ${e.execution.task.name}`);
        })
    );
    context.subscriptions.push(
        vscode.tasks.onDidEndTask((e) => {
            showAgent('task-agent', 'Dave', 'DevOps', 'talking',
                `Task complete: ${e.execution.task.name}`, 'Carol');
        })
    );

    // ─── 13. DEBUG SESSION EVENTS ───
    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession((session) => {
            showAgent('debug-agent', 'Carol', 'Tester', 'coding',
                `Debugging: ${session.name}`);
        })
    );
    context.subscriptions.push(
        vscode.debug.onDidTerminateDebugSession((session) => {
            showAgent('debug-agent', 'Carol', 'Tester', 'talking',
                `Debug ended: ${session.name}`, 'Bob');
        })
    );

    console.log('[AgentViz] Comprehensive real-time monitor started — capturing ALL events');
}

// ──────────────────────────────────────────────
// EXTENSION ACTIVATION
// ──────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
    console.log('[AgentViz] Agent Visualizer activated — monitoring all activity');

    // 1. Open Panel Command
    const openCmd = vscode.commands.registerCommand('agentViz.openPanel', () => openPanel(context));
    context.subscriptions.push(openCmd);

    // 2. Chat Participant (@visualize)
    const chatHandler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        _context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ) => {
        vscode.commands.executeCommand('agentViz.openPanel');
        postAgentEvent('/api/prompt', { text: request.prompt });
        stream.progress('Planning the task...');

        try {
            const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
            if (!model) {
                stream.markdown('No language model found.');
                return { errorDetails: { message: 'Model not found' } };
            }

            const userMessage = vscode.LanguageModelChatMessage.User(
                `You are a dev team orchestrator. Break this task into 4-6 steps. ` +
                `Assign roles: architect, developer, tester, pm. ` +
                `Respond JSON only: [{"role":"...","name":"...","action":"thinking|coding|reviewing|talking|break","message":"..."}]\n\n` +
                `Task: ${request.prompt}`
            );

            const response = await model.sendRequest([userMessage], {}, token);
            let aiOutput = '';
            for await (const chunk of response.text) { aiOutput += chunk; }

            let plan: any[];
            try { plan = JSON.parse(aiOutput.replace(/```json/g, '').replace(/```/g, '').trim()); }
            catch {
                plan = [
                    { role: 'architect', name: 'Alice', action: 'thinking', message: `Analyzing: ${request.prompt}` },
                    { role: 'developer', name: 'Bob', action: 'coding', message: 'Implementing...' },
                    { role: 'tester', name: 'Carol', action: 'reviewing', message: 'Testing...' }
                ];
            }

            stream.markdown('**Plan:**\n\n');
            for (const s of plan) stream.markdown(`- **${s.name} (${s.role})**: ${s.message}\n`);

            stream.progress('Agents working...');
            let i = 1;
            for (const s of plan) {
                if (token.isCancellationRequested) break;
                showAgent(`chat-${i}`, s.name, s.role, s.action, s.message, s.target);
                await new Promise(r => setTimeout(r, 3000));
                i++;
            }
            for (let j = 1; j < i; j++) { removeAgent(`chat-${j}`); await new Promise(r => setTimeout(r, 500)); }

            stream.markdown('\n\n✅ Done!');
            return {};
        } catch (err: any) {
            stream.markdown(`Error: ${err.message}`);
            return { errorDetails: { message: err.message } };
        }
    };

    const participant = vscode.chat.createChatParticipant('agentViz.participant', chatHandler);
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    context.subscriptions.push(participant);

    // 3. START THE MONITOR — captures EVERYTHING
    startRealtimeMonitor(context);

    // Initial prompt
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.name || 'Workspace';
    postAgentEvent('/api/prompt', { text: `Antigravity — ${wsFolder}` });
}

// ──────────────────────────────────────────────
// WEBVIEW PANEL
// ──────────────────────────────────────────────
function openPanel(context: vscode.ExtensionContext) {
    if (currentPanel) { currentPanel.reveal(vscode.ViewColumn.One); return; }
    currentPanel = vscode.window.createWebviewPanel(
        'agentVisualizer', '🏢 Agent Office', vscode.ViewColumn.One,
        {
            enableScripts: true, retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
        }
    );

    const htmlPath = path.join(context.extensionPath, 'media', 'office.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    const mediaUri = currentPanel.webview.asWebviewUri(
        vscode.Uri.file(path.join(context.extensionPath, 'media'))
    );
    html = html.replace(/{{mediaUri}}/g, mediaUri.toString());
    currentPanel.webview.html = html;
    connectToServer(currentPanel);

    currentPanel.onDidDispose(() => {
        currentPanel = undefined;
        if (wsConnection) { wsConnection.close(); wsConnection = undefined; }
    }, null, context.subscriptions);
}

function connectToServer(panel: vscode.WebviewPanel) {
    try {
        const WebSocket = require('ws');
        if (wsConnection) wsConnection.close();
        wsConnection = new WebSocket('ws://localhost:3777');
        wsConnection.on('open', () => panel.webview.postMessage({ type: 'connection', status: 'connected' }));
        wsConnection.on('message', (data: any) => {
            try { panel.webview.postMessage(JSON.parse(data.toString())); } catch { }
        });
        wsConnection.on('close', () => {
            panel.webview.postMessage({ type: 'connection', status: 'disconnected' });
            setTimeout(() => { if (currentPanel) connectToServer(panel); }, 3000);
        });
        wsConnection.on('error', (err: any) => {
            panel.webview.postMessage({ type: 'connection', status: 'error', error: err.message });
        });
    } catch (err: any) {
        panel.webview.postMessage({ type: 'connection', status: 'error', error: err.message });
    }
}

export function deactivate() {
    for (const [id, timer] of agentTimers) {
        clearTimeout(timer);
        postAgentEvent('/api/agent', { id, remove: true });
    }
    agentTimers.clear();
    if (wsConnection) wsConnection.close();
}
