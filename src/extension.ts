import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';

const PIXEL_ART_SERVER = 'http://localhost:3777';

let currentPanel: vscode.WebviewPanel | undefined;
let wsConnection: any;

// Helper to post events to the Docker Agent API
async function postAgentEvent(endpoint: string, data: any): Promise<void> {
    return new Promise((resolve) => {
        try {
            const payload = JSON.stringify(data);
            const url = new URL(endpoint, PIXEL_ART_SERVER);
            const req = http.request(
                {
                    hostname: url.hostname,
                    port: url.port,
                    path: url.pathname,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload)
                    }
                },
                (res) => {
                    res.on('data', () => { });
                    res.on('end', () => resolve());
                }
            );
            req.on('error', (e) => {
                console.error('[AgentViz API Error]', e);
                resolve(); // Continue even if visualizer is offline
            });
            req.write(payload);
            req.end();
        } catch (e) {
            console.error(e);
            resolve();
        }
    });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function activate(context: vscode.ExtensionContext) {
    console.log('Agent Visualizer extension activated');

    // 1. Register Webview Panel Command
    const openCmd = vscode.commands.registerCommand('agentViz.openPanel', () => openPanel(context));
    context.subscriptions.push(openCmd);

    // 2. Register Chat Participant
    const chatHandler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        contextInfo: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ) => {
        // Open panel automatically when someone chats with @visualize
        vscode.commands.executeCommand('agentViz.openPanel');

        // Announce start of prompt to backend API
        await postAgentEvent('/api/prompt', { text: request.prompt });

        stream.progress('Planning the task...');

        try {
            // Find a suitable language model provided by Antigravity or VS Code Copilot
            const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });

            if (!model) {
                stream.markdown('No suitable language model found. Please ensure Antigravity AI or Copilot is enabled.');
                return { errorDetails: { message: 'Model not found' } };
            }

            // We will ask the model to break down the task and generate a JSON array of events, 
            // but to still stream text to the user.
            const prompt = `
You are a development team orchestrator. Build a plan for the user's task.
Break the user's task into 4-6 sequential steps.
For each step, assign one of these roles: architect, developer, tester, pm.
Respond in valid JSON format only, without markdown blocks, matching this exact schema:
[
  { "role": "architect", "name": "Alice", "action": "thinking", "message": "Planning..." },
  { "role": "developer", "name": "Bob", "action": "coding", "message": "Writing code..." }
]
Actions can be: thinking, talking, coding, reviewing, break.

User Task: ${request.prompt}
`;
            const userMessage = vscode.LanguageModelChatMessage.User(prompt);

            const response = await model.sendRequest([userMessage], {}, token);

            let aiOutput = '';
            for await (const chunk of response.text) {
                aiOutput += chunk;
            }

            // Try to parse JSON from output (strip markdown blocks if any)
            let planJson = aiOutput.replace(/```json/g, '').replace(/```/g, '').trim();
            let plan: any[] = [];
            try {
                plan = JSON.parse(planJson);
            } catch (e) {
                stream.markdown('Failed to generate a valid plan. Defaulting to a generic workflow...\n');
                plan = [
                    { role: 'architect', name: 'Alice', action: 'thinking', message: `Analyzing: ${request.prompt}` },
                    { role: 'developer', name: 'Bob', action: 'coding', message: 'Implementing initial code' },
                    { role: 'tester', name: 'Carol', action: 'reviewing', message: 'Testing the implementation' }
                ];
            }

            stream.markdown('Here is the execution plan:\n\n');
            for (const step of plan) {
                stream.markdown(`- **${step.name} (${step.role})**: ${step.message}\n`);
            }

            // Simulate the execution inside the Pixel Art Office
            stream.progress('Agents are now working inside the office...');

            let i = 1;
            for (const step of plan) {
                if (token.isCancellationRequested) {
                    break;
                }

                const agentId = `agent-${i}`;

                // Spawn/Update Agent
                await postAgentEvent('/api/agent', {
                    id: agentId,
                    name: step.name,
                    role: step.role,
                    action: step.action,
                    message: step.message,
                    target: step.target || undefined
                });

                // Wait a bit so the user can watch the animation
                await sleep(3000);
                i++;
            }

            // Despawn agents
            for (let j = 1; j < i; j++) {
                await postAgentEvent('/api/agent', { id: `agent-${j}`, remove: true });
                await sleep(500);
            }

            stream.markdown('\n\n✅ Task simulation completed in the office!');

            return {};

        } catch (err: any) {
            console.error(err);
            stream.markdown(`An error occurred: ${err.message}`);
            return { errorDetails: { message: err.message } };
        }
    };

    const participant = vscode.chat.createChatParticipant('agentViz.participant', chatHandler);
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    context.subscriptions.push(participant);
}

function openPanel(context: vscode.ExtensionContext) {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'agentVisualizer',
        '🏢 Agent Office',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(context.extensionPath, 'media'))
            ]
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

    currentPanel.onDidDispose(
        () => {
            currentPanel = undefined;
            if (wsConnection) {
                wsConnection.close();
                wsConnection = undefined;
            }
        },
        null,
        context.subscriptions
    );
}

function connectToServer(panel: vscode.WebviewPanel) {
    try {
        const WebSocket = require('ws');
        const serverUrl = 'ws://localhost:3777';

        if (wsConnection) {
            wsConnection.close();
        }

        wsConnection = new WebSocket(serverUrl);

        wsConnection.on('open', () => {
            panel.webview.postMessage({ type: 'connection', status: 'connected' });
        });

        wsConnection.on('message', (data: any) => {
            try {
                const parsed = JSON.parse(data.toString());
                panel.webview.postMessage(parsed);
            } catch (e) {
                console.error('[AgentViz] Parse error:', e);
            }
        });

        wsConnection.on('close', () => {
            panel.webview.postMessage({ type: 'connection', status: 'disconnected' });
            setTimeout(() => {
                if (currentPanel) connectToServer(panel);
            }, 3000);
        });

        wsConnection.on('error', (err: any) => {
            panel.webview.postMessage({ type: 'connection', status: 'error', error: err.message });
        });
    } catch (err: any) {
        panel.webview.postMessage({ type: 'connection', status: 'error', error: err.message });
    }
}

export function deactivate() {
    if (wsConnection) {
        wsConnection.close();
    }
}
