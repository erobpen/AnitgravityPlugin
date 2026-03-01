import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

let currentPanel: vscode.WebviewPanel | undefined;
let wsConnection: any;

export function activate(context: vscode.ExtensionContext) {
    console.log('Agent Visualizer extension activated');

    const openCmd = vscode.commands.registerCommand('agentViz.openPanel', () => {
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

        // Load the HTML
        const htmlPath = path.join(context.extensionPath, 'media', 'office.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        // Fix resource URIs for webview
        const mediaUri = currentPanel.webview.asWebviewUri(
            vscode.Uri.file(path.join(context.extensionPath, 'media'))
        );
        html = html.replace(/{{mediaUri}}/g, mediaUri.toString());

        currentPanel.webview.html = html;

        // Connect to Docker WebSocket server
        connectToServer(currentPanel);

        // Handle messages from the webview
        currentPanel.webview.onDidReceiveMessage(
            (message: any) => {
                switch (message.command) {
                    case 'reconnect':
                        connectToServer(currentPanel!);
                        break;
                    case 'log':
                        console.log('[Webview]', message.text);
                        break;
                }
            },
            undefined,
            context.subscriptions
        );

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
    });

    context.subscriptions.push(openCmd);
}

function connectToServer(panel: vscode.WebviewPanel) {
    try {
        // Dynamic import of ws module
        const WebSocket = require('ws');
        const serverUrl = 'ws://localhost:3777';

        if (wsConnection) {
            wsConnection.close();
        }

        wsConnection = new WebSocket(serverUrl);

        wsConnection.on('open', () => {
            console.log('[AgentViz] Connected to Docker server');
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
            console.log('[AgentViz] Disconnected from server');
            panel.webview.postMessage({ type: 'connection', status: 'disconnected' });
            // Auto-reconnect after 3 seconds
            setTimeout(() => {
                if (currentPanel) {
                    connectToServer(panel);
                }
            }, 3000);
        });

        wsConnection.on('error', (err: any) => {
            console.error('[AgentViz] WebSocket error:', err.message);
            panel.webview.postMessage({ type: 'connection', status: 'error', error: err.message });
        });
    } catch (err: any) {
        console.error('[AgentViz] Failed to connect:', err.message);
        panel.webview.postMessage({ type: 'connection', status: 'error', error: err.message });
    }
}

export function deactivate() {
    if (wsConnection) {
        wsConnection.close();
    }
}
