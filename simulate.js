/**
 * simulate.js — Sends mock agent events to the Docker server
 * Usage: node simulate.js
 */

const http = require('http');

const BASE_URL = 'http://localhost:3777';

function post(path, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const url = new URL(path, BASE_URL);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
            },
        };

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch {
                    resolve(body);
                }
            });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function simulate() {
    console.log('🎬 Starting agent simulation...\n');

    // ── 1. Start a new prompt session ──
    console.log('📝 New prompt: "Build a user authentication system with OAuth2"');
    await post('/api/prompt', {
        text: 'Build a user authentication system with OAuth2'
    });
    await sleep(1500);

    // ── 2. Spawn the planner agent ──
    console.log('👤 Spawning: Alice (Architect)');
    await post('/api/agent', {
        id: 'agent-1',
        name: 'Alice',
        role: 'architect',
        action: 'thinking',
        message: 'Analyzing requirements for OAuth2 auth system...'
    });
    await sleep(2500);

    // ── 3. Alice starts planning ──
    console.log('💭 Alice is thinking about the architecture...');
    await post('/api/agent', {
        id: 'agent-1',
        action: 'thinking',
        message: 'Need a token service, user store, and OAuth provider integration...'
    });
    await sleep(2000);

    // ── 4. Spawn the developer agent ──
    console.log('👤 Spawning: Bob (Developer)');
    await post('/api/agent', {
        id: 'agent-2',
        name: 'Bob',
        role: 'developer',
        action: 'idle',
        message: 'Ready to code!'
    });
    await sleep(1500);

    // ── 5. Alice talks to Bob ──
    console.log('💬 Alice → Bob: Delegating auth module');
    await post('/api/agent', {
        id: 'agent-1',
        action: 'talking',
        message: 'Bob, implement the JWT token service first',
        target: 'Bob'
    });
    await sleep(2500);

    // ── 6. Bob starts coding ──
    console.log('⌨️  Bob is coding...');
    await post('/api/agent', {
        id: 'agent-2',
        action: 'coding',
        message: 'Writing token service with RS256 signing...'
    });
    await sleep(2000);

    // ── 7. Spawn the tester ──
    console.log('👤 Spawning: Carol (Tester)');
    await post('/api/agent', {
        id: 'agent-3',
        name: 'Carol',
        role: 'tester',
        action: 'thinking',
        message: 'Preparing test scenarios for auth flow...'
    });
    await sleep(2000);

    // ── 8. Spawn another developer ──
    console.log('👤 Spawning: Dave (Developer)');
    await post('/api/agent', {
        id: 'agent-4',
        name: 'Dave',
        role: 'developer',
        action: 'idle',
        message: 'Checking in, what needs to be done?'
    });
    await sleep(1500);

    // ── 9. Alice delegates to Dave ──
    console.log('💬 Alice → Dave: OAuth provider integration');
    await post('/api/agent', {
        id: 'agent-1',
        action: 'talking',
        message: 'Dave, handle the Google/GitHub OAuth provider integration',
        target: 'Dave'
    });
    await sleep(2000);

    // ── 10. Dave starts coding ──
    console.log('⌨️  Dave is coding...');
    await post('/api/agent', {
        id: 'agent-4',
        action: 'coding',
        message: 'Setting up OAuth2 client with PKCE flow...'
    });
    await sleep(2000);

    // ── 11. Bob goes reviewing ──
    console.log('📋 Bob reviewing at the whiteboard...');
    await post('/api/agent', {
        id: 'agent-2',
        action: 'reviewing',
        message: 'Token service is complete, reviewing the code...'
    });
    await sleep(2500);

    // ── 12. Carol talks to Bob ──
    console.log('💬 Carol → Bob: Test results');
    await post('/api/agent', {
        id: 'agent-3',
        action: 'talking',
        message: 'Bob, all 12 unit tests passing for token service!',
        target: 'Bob'
    });
    await sleep(2500);

    // ── 13. Spawn the PM ──
    console.log('👤 Spawning: Eve (PM)');
    await post('/api/agent', {
        id: 'agent-5',
        name: 'Eve',
        role: 'pm',
        action: 'thinking',
        message: 'Reviewing project progress...'
    });
    await sleep(2000);

    // ── 14. Eve talks to Alice ──
    console.log('💬 Eve → Alice: Status update');
    await post('/api/agent', {
        id: 'agent-5',
        action: 'talking',
        message: 'Alice, what is the ETA for the OAuth2 module?',
        target: 'Alice'
    });
    await sleep(2000);

    // ── 15. Alice responds ──
    console.log('💬 Alice → Eve: Update');
    await post('/api/agent', {
        id: 'agent-1',
        action: 'talking',
        message: 'Token service done. OAuth integration 70% complete.',
        target: 'Eve'
    });
    await sleep(2000);

    // ── 16. Everyone takes a break ──
    console.log('☕ Coffee break!');
    await post('/api/agent', { id: 'agent-2', action: 'break', message: 'Need coffee ☕' });
    await sleep(1000);
    await post('/api/agent', { id: 'agent-4', action: 'break', message: 'Coffee time!' });
    await sleep(3000);

    // ── 17. Dave finishes ──
    console.log('✅ Dave finished OAuth integration');
    await post('/api/agent', {
        id: 'agent-4',
        action: 'coding',
        message: 'OAuth2 integration complete. PR ready.'
    });
    await sleep(2000);

    // ── 18. Agents start finishing up ──
    console.log('🏁 Agents finishing up...');
    await post('/api/agent', { id: 'agent-3', action: 'thinking', message: 'All tests green. Integration verified.' });
    await sleep(1500);

    await post('/api/agent', { id: 'agent-5', action: 'talking', message: 'Great work team! Shipping to production.', target: 'All' });
    await sleep(2000);

    // ── 19. Remove agents ──
    console.log('👋 Agents leaving...');
    await post('/api/agent', { id: 'agent-3', remove: true });
    await sleep(800);
    await post('/api/agent', { id: 'agent-4', remove: true });
    await sleep(800);
    await post('/api/agent', { id: 'agent-2', remove: true });
    await sleep(800);
    await post('/api/agent', { id: 'agent-5', remove: true });
    await sleep(800);
    await post('/api/agent', { id: 'agent-1', remove: true });

    console.log('\n🎬 Simulation complete!');
}

simulate().catch(err => {
    console.error('Simulation error:', err.message);
    console.error('Is the Docker server running? Try: docker-compose up --build');
});
