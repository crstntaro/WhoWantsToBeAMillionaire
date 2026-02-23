const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});
const PORT = 3000;

// ── GitHub Pages URL for the player page (enables cross-network play) ──
// Players load the HTML from GitHub Pages, socket.io connects back to this server.
const GITHUB_PAGES_URL = 'https://crstntaro.github.io/WhoWantsToBeAMillionaire/public/player.html';

app.use(express.static('public'));

// Serve host at root
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/host.html');
});

// ── Get local network IP ──
function getLocalIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return 'localhost';
}

// ── Tunnel state ──
let tunnelUrl = null;

// ── Game state ──
let players = [];        // { id, name, score, currentAnswer, answered }
let answersOpen = false;
let questionRevealed = false;
let currentQuestion = null;
let joinLocked = false;

// Build the player URL: GitHub Pages + ?host= param (preferred) or local URL
function buildPlayerUrl(socketBase) {
    if (GITHUB_PAGES_URL) {
        return `${GITHUB_PAGES_URL}?host=${encodeURIComponent(socketBase)}`;
    }
    return `${socketBase}/player.html`;
}

// ── REST endpoint for QR code + server info ──
app.get('/api/info', async (req, res) => {
    const ip = getLocalIP();
    const localBase = `http://${ip}:${PORT}`;
    // Use tunnel as socket base if available, else LAN
    const socketBase = tunnelUrl || localBase;
    const qrTarget = buildPlayerUrl(socketBase);
    const localPlayerUrl = buildPlayerUrl(localBase);
    try {
        const qr = await QRCode.toDataURL(qrTarget, { width: 300, margin: 2, color: { dark: '#f5c518', light: '#06081a' } });
        res.json({ qr, url: qrTarget, localUrl: localPlayerUrl, publicUrl: tunnelUrl ? buildPlayerUrl(tunnelUrl) : null, ip, port: PORT });
    } catch (e) {
        res.json({ qr: null, url: qrTarget, localUrl: localPlayerUrl, publicUrl: null, ip, port: PORT });
    }
});

// ── Socket.io ──
io.on('connection', (socket) => {

    // ─ Player joins ─
    socket.on('player-join', ({ name }) => {
        if (!name) return socket.emit('join-error', 'Name is required');
        const trimmed = name.trim().substring(0, 20);

        if (joinLocked) {
            // Allow reconnection by name
            const existing = players.find(p => p.name === trimmed);
            if (existing) {
                existing.id = socket.id;
                socket.playerData = existing;
                socket.join('players');
                socket.emit('join-success', { name: existing.name, score: existing.score });
                broadcastRoster();
                broadcastPlayerCount();
                if (currentQuestion) socket.emit('question-loaded', currentQuestion);
                console.log(`  ↩ ${trimmed} reconnected`);
                return;
            }
            return socket.emit('join-error', 'Game has already started. You can no longer join.');
        }

        if (players.find(p => p.name === trimmed)) {
            return socket.emit('join-error', 'That name is already taken. Try a different one.');
        }

        const player = { id: socket.id, name: trimmed, score: 0, currentAnswer: null, answered: false };
        players.push(player);
        socket.playerData = player;
        socket.join('players');
        socket.emit('join-success', { name: player.name, score: 0 });
        broadcastRoster();
        broadcastPlayerCount();
        console.log(`  ✓ ${trimmed} joined (${players.length} total)`);
    });

    // ─ Host: lock joining ─
    socket.on('lock-joining', () => {
        joinLocked = true;
        io.emit('joining-locked');
        console.log(`  🔒 Game locked — ${players.length} players registered`);
    });

    // ─ Host: load question (sync to players, reset answers) ─
    socket.on('load-question', (data) => {
        currentQuestion = data;
        answersOpen = false;
        questionRevealed = false;
        players.forEach(p => { p.currentAnswer = null; p.answered = false; });
        io.to('players').emit('question-loaded', data);
        broadcastAnswerCount();
    });

    // ─ Host: open answers ─
    socket.on('open-answers', () => {
        if (questionRevealed) return; // don't re-open after reveal
        answersOpen = true;
        players.forEach(p => { p.currentAnswer = null; p.answered = false; });
        io.to('players').emit('answers-opened');
        broadcastAnswerCount();
        console.log('  ✅ Answers opened');
    });

    // ─ Host: close answers ─
    socket.on('close-answers', () => {
        answersOpen = false;
        io.to('players').emit('answers-closed');
        console.log(`  🛑 Answers closed (${players.filter(p => p.answered).length}/${players.length} answered)`);
    });

    // ─ Player: submit answer ─
    socket.on('submit-answer', ({ optionIndex }) => {
        if (!answersOpen) return;
        const player = players.find(p => p.id === socket.id);
        if (!player || player.answered) return;
        if (typeof optionIndex !== 'number' || optionIndex < 0 || optionIndex > 3) return;
        player.currentAnswer = optionIndex;
        player.answered = true;
        broadcastAnswerCount();
        console.log(`  📝 ${player.name} answered ${['A','B','C','D'][optionIndex]} (${players.filter(p => p.answered).length}/${players.length})`);
    });

    // ─ Host: reveal answer — server-side scoring ─
    socket.on('reveal-answer', ({ correctIndex, points }) => {
        if (questionRevealed) return; // prevent double-scoring
        questionRevealed = true;
        answersOpen = false;
        io.to('players').emit('answers-closed');

        // Tally distribution
        const dist = [0, 0, 0, 0];
        let notAnswered = 0;

        players.forEach(p => {
            if (p.answered && p.currentAnswer !== null && p.currentAnswer >= 0 && p.currentAnswer <= 3) {
                dist[p.currentAnswer]++;
            } else {
                notAnswered++;
            }

            const wasCorrect = p.answered && p.currentAnswer === correctIndex;
            if (wasCorrect) p.score += points;

            // Send individual result to each player
            const playerSocket = io.sockets.sockets.get(p.id);
            if (playerSocket) {
                playerSocket.emit('answer-result', {
                    wasCorrect,
                    yourAnswer: p.currentAnswer,
                    correctIndex,
                    points: wasCorrect ? points : 0,
                    totalScore: p.score,
                    answered: p.answered
                });
            }
        });

        const scoreboard = getScoreboard();
        // Send distribution + new scoreboard to host
        socket.emit('answer-revealed', { distribution: dist, notAnswered, scoreboard });
        // Broadcast updated scoreboard to all
        io.emit('scoreboard-update', scoreboard);

        console.log(`  📊 Revealed Q correctIndex=${correctIndex}: ${dist[correctIndex]} correct / ${players.length} total`);
    });

    // ─ Host: round splash ─
    socket.on('round-splash', (data) => {
        io.to('players').emit('round-splash', data);
    });

    // ─ Host: game over ─
    socket.on('game-over', () => {
        const rankings = getScoreboard();
        io.to('players').emit('game-over', { rankings });
    });

    // ─ Host: reset game ─
    socket.on('reset-game', () => {
        players = [];
        answersOpen = false;
        questionRevealed = false;
        currentQuestion = null;
        joinLocked = false;
        io.emit('game-reset');
        console.log('  🔄 Game reset');
    });

    // ─ Disconnect ─
    socket.on('disconnect', () => {
        const player = players.find(p => p.id === socket.id);
        if (player) {
            if (joinLocked) {
                // Game in progress: keep for reconnection
                player.id = null;
                console.log(`  ⚡ ${player.name} disconnected — can rejoin`);
            } else {
                // Lobby: remove entirely
                players = players.filter(p => p.id !== socket.id);
                console.log(`  ✗ ${player.name} left`);
            }
        }
        broadcastRoster();
        broadcastPlayerCount();
    });
});

function broadcastRoster() {
    const roster = players.filter(p => p.id).map(p => p.name);
    io.emit('roster-update', roster);
}

function broadcastPlayerCount() {
    const connected = players.filter(p => p.id).length;
    io.emit('player-count', { connected, total: players.length });
}

function broadcastAnswerCount() {
    const answered = players.filter(p => p.answered).length;
    const total = players.length;
    io.emit('answer-count', { answered, total });
}

function getScoreboard() {
    return players
        .map(p => ({ name: p.name, score: p.score }))
        .sort((a, b) => b.score - a.score);
}

// ── Start ──
server.listen(PORT, '0.0.0.0', async () => {
    const ip = getLocalIP();
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║   WHO WANTS TO BE A MILLIONAIRE? - SERVER   ║');
    console.log('  ╠══════════════════════════════════════════════╣');
    console.log(`  ║  Host:    http://localhost:${PORT}              ║`);
    console.log(`  ║  LAN:     http://${ip}:${PORT}/player.html  ║`);
    console.log('  ╠══════════════════════════════════════════════╣');
    console.log('  ║  Starting public tunnel (any network)...    ║');
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');

    // Try to open a public tunnel so players on any network can join
    try {
        const localtunnel = require('localtunnel');
        const tunnel = await localtunnel({ port: PORT });
        tunnelUrl = tunnel.url;
        const publicPlayerUrl = buildPlayerUrl(tunnelUrl);
        console.log(`  🌐 Public player URL: ${publicPlayerUrl}`);
        console.log('     (Works over any internet connection)');
        console.log('');
        // Notify already-connected host screens about the new URL
        io.emit('tunnel-ready', { publicUrl: publicPlayerUrl });

        tunnel.on('close', () => {
            tunnelUrl = null;
            console.log('  ⚡ Public tunnel closed');
        });
        tunnel.on('error', () => { tunnelUrl = null; });
    } catch (e) {
        console.log('  ⚠️  Could not open public tunnel.');
        console.log('     Players must be on the same WiFi network.');
        console.log('     (Run `npm install` to enable tunnel support)');
        console.log('');
    }
});
