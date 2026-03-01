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
let currentPanel;
let wsConnection;
function activate(context) {
    console.log('Agent Visualizer extension activated');
    const openCmd = vscode.commands.registerCommand('agentViz.openPanel', () => {
        if (currentPanel) {
            currentPanel.reveal(vscode.ViewColumn.One);
            return;
        }
        currentPanel = vscode.window.createWebviewPanel('agentVisualizer', '🏢 Agent Office', vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(context.extensionPath, 'media'))
            ]
        });
        // Load the HTML
        const htmlPath = path.join(context.extensionPath, 'media', 'office.html');
        let html = fs.readFileSync(htmlPath, 'utf8');
        // Fix resource URIs for webview
        const mediaUri = currentPanel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media')));
        html = html.replace(/{{mediaUri}}/g, mediaUri.toString());
        currentPanel.webview.html = html;
        // Connect to Docker WebSocket server
        connectToServer(currentPanel);
        // Handle messages from the webview
        currentPanel.webview.onDidReceiveMessage((message) => {
            switch (message.command) {
                case 'reconnect':
                    connectToServer(currentPanel);
                    break;
                case 'log':
                    console.log('[Webview]', message.text);
                    break;
            }
        }, undefined, context.subscriptions);
        currentPanel.onDidDispose(() => {
            currentPanel = undefined;
            if (wsConnection) {
                wsConnection.close();
                wsConnection = undefined;
            }
        }, null, context.subscriptions);
    });
    context.subscriptions.push(openCmd);
}
function connectToServer(panel) {
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
        wsConnection.on('message', (data) => {
            try {
                const parsed = JSON.parse(data.toString());
                panel.webview.postMessage(parsed);
            }
            catch (e) {
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
        wsConnection.on('error', (err) => {
            console.error('[AgentViz] WebSocket error:', err.message);
            panel.webview.postMessage({ type: 'connection', status: 'error', error: err.message });
        });
    }
    catch (err) {
        console.error('[AgentViz] Failed to connect:', err.message);
        panel.webview.postMessage({ type: 'connection', status: 'error', error: err.message });
    }
}
function deactivate() {
    if (wsConnection) {
        wsConnection.close();
    }
}
//# sourceMappingURL=extension.js.map