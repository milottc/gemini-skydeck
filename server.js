const http = require('http');
const express = require('express');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const GLOBAL_ROOM = 'GLOBAL';

app.use(express.static(path.resolve(__dirname), {
  index: 'index.html',
  extensions: ['html']
}));

// Single authoritative global world server: Map<playerId, PlayerRecord>
const players = new Map();
let nextSeq = 1;

function cleanCallsign(raw, fallback) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9 _-]/g, '').trim().slice(0, 14);
  return s || fallback;
}

function serializePlayer(p) {
  return {
    id: p.id,
    callsign: p.callsign,
    room: GLOBAL_ROOM,
    modelId: p.modelId,
    liveryIdx: p.liveryIdx,
    airport: p.airport,
    flying: !!p.flying,
    lat: p.lat,
    lon: p.lon,
    alt: p.alt,
    qx: p.qx,
    qy: p.qy,
    qz: p.qz,
    qw: p.qw,
    spd: p.spd,
    hdg: p.hdg,
    vs: p.vs,
    gearPos: p.gearPos,
    flaps: p.flaps,
    throttle: p.throttle,
    crashed: p.crashed,
    updatedAt: p.updatedAt
  };
}

function broadcastGlobal(payload, excludeId) {
  const msg = JSON.stringify(payload);
  for (const p of players.values()) {
    if (excludeId && p.id === excludeId) continue;
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      try {
        p.ws.send(msg);
      } catch (_) {}
    }
  }
}

function removePlayer(player) {
  if (!player || !player.joined) return;
  const existed = players.delete(player.id);
  player.joined = false;
  if (existed) {
    broadcastGlobal({ type: 'player:left', id: player.id }, player.id);
  }
}

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, server: GLOBAL_ROOM, rooms: 1, players: players.size });
});

app.get('/api/players', (_req, res) => {
  const list = [];
  for (const p of players.values()) list.push(serializePlayer(p));
  res.status(200).json({ server: GLOBAL_ROOM, count: list.length, players: list });
});

app.get('/api/rooms', (_req, res) => {
  res.status(200).json({ rooms: [{ id: GLOBAL_ROOM, players: players.size }] });
});

app.use((_req, res) => {
  res.sendFile(path.resolve(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function applyTelemetry(player, d) {
  const num = (v, fb) => (Number.isFinite(v) ? v : fb);
  player.lat = num(d.lat, player.lat);
  player.lon = num(d.lon, player.lon);
  player.alt = num(d.alt, player.alt);

  const qx = num(d.qx, player.qx);
  const qy = num(d.qy, player.qy);
  const qz = num(d.qz, player.qz);
  const qw = num(d.qw, player.qw);
  const qLen = Math.hypot(qx, qy, qz, qw);
  if (qLen > 0.001) {
    player.qx = qx / qLen;
    player.qy = qy / qLen;
    player.qz = qz / qLen;
    player.qw = qw / qLen;
  }

  player.spd = num(d.spd, player.spd);
  player.hdg = num(d.hdg, player.hdg);
  player.vs = num(d.vs, player.vs);
  player.gearPos = num(d.gearPos, player.gearPos);
  player.flaps = num(d.flaps, player.flaps);
  player.throttle = num(d.throttle, player.throttle);
  player.crashed = !!d.crashed;
  if (typeof d.flying === 'boolean') player.flying = d.flying;
  if (typeof d.modelId === 'string') player.modelId = d.modelId.slice(0, 24);
  if (Number.isFinite(d.liveryIdx)) player.liveryIdx = Math.max(0, d.liveryIdx | 0);
  if (typeof d.airport === 'string') player.airport = d.airport.slice(0, 12);
  if (typeof d.callsign === 'string') player.callsign = cleanCallsign(d.callsign, player.callsign);
}

function joinGlobal(player, data) {
  const wasJoined = player.joined;
  player.callsign = cleanCallsign(data && data.callsign, player.callsign);
  if (data && typeof data.modelId === 'string') player.modelId = data.modelId.slice(0, 24);
  if (data && Number.isFinite(data.liveryIdx)) player.liveryIdx = Math.max(0, data.liveryIdx | 0);
  if (data && typeof data.airport === 'string') player.airport = data.airport.slice(0, 12);
  if (data && typeof data.flying === 'boolean') player.flying = data.flying;
  if (data && data.state && typeof data.state === 'object') applyTelemetry(player, data.state);

  player.joined = true;
  player.updatedAt = Date.now();

  const others = [];
  for (const other of players.values()) {
    if (other.id !== player.id) others.push(serializePlayer(other));
  }
  players.set(player.id, player);

  if (player.ws && player.ws.readyState === WebSocket.OPEN) {
    try {
      player.ws.send(JSON.stringify({
        type: 'welcome',
        playerId: player.id,
        room: GLOBAL_ROOM,
        callsign: player.callsign,
        players: others
      }));
    } catch (_) {}
  }

  broadcastGlobal({
    type: wasJoined ? 'player:state' : 'player:joined',
    player: serializePlayer(player)
  }, player.id);
}

wss.on('connection', (ws) => {
  const playerId = 'P' + (nextSeq++).toString(36).toUpperCase();
  const player = {
    id: playerId,
    ws,
    isAlive: true,
    joined: false,
    callsign: 'PILOT-' + playerId,
    modelId: '737',
    liveryIdx: 0,
    airport: 'LSZH',
    flying: false,
    lat: 47.4647,
    lon: 8.5492,
    alt: 900,
    qx: 0, qy: 1, qz: 0, qw: 0,
    spd: 0,
    hdg: 0,
    vs: 0,
    gearPos: 1,
    flaps: 0,
    throttle: 0,
    crashed: false,
    updatedAt: Date.now()
  };

  ws.on('pong', () => {
    player.isAlive = true;
  });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch (_) {
      return;
    }
    if (!data || typeof data !== 'object') return;

    player.isAlive = true;

    if (data.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch (_) {}
      return;
    }

    if (data.type === 'join') {
      joinGlobal(player, data);
      return;
    }

    // Auto-join global server if telemetry/chat arrives before explicit join
    if (!player.joined) {
      joinGlobal(player, data);
    }

    if (data.type === 'state') {
      applyTelemetry(player, data);
      player.updatedAt = Date.now();
      broadcastGlobal({
        type: 'player:state',
        player: serializePlayer(player)
      }, player.id);
      return;
    }

    if (data.type === 'chat') {
      const text = String(data.text || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 140);
      if (!text) return;
      broadcastGlobal({
        type: 'chat:msg',
        id: player.id,
        callsign: player.callsign,
        text,
        ts: Date.now()
      });
      return;
    }

    if (data.type === 'fp_share' && Array.isArray(data.wps)) {
      const wps = data.wps.slice(0, 24).map((w) => ({
        name: String(w.name || 'WPT').slice(0, 14),
        lat: Number(w.lat),
        lon: Number(w.lon),
        alt: w.alt != null && Number.isFinite(Number(w.alt)) ? Math.round(Number(w.alt)) : null
      })).filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lon));
      if (!wps.length) return;
      broadcastGlobal({
        type: 'fp:shared',
        id: player.id,
        callsign: player.callsign,
        dep: String(data.dep || '').slice(0, 10),
        dest: String(data.dest || '').slice(0, 10),
        wps,
        ts: Date.now()
      }, player.id);
    }
  });

  ws.on('close', () => removePlayer(player));
  ws.on('error', () => removePlayer(player));
});

// Heartbeat & stale socket cleanup every 15s
const heartbeatInterval = setInterval(() => {
  const now = Date.now();
  for (const player of players.values()) {
    if (!player.ws || player.ws.readyState !== WebSocket.OPEN) {
      removePlayer(player);
      continue;
    }
    if (!player.isAlive && now - player.updatedAt > 20000) {
      try { player.ws.terminate(); } catch (_) {}
      removePlayer(player);
      continue;
    }
    player.isAlive = false;
    try { player.ws.ping(); } catch (_) {}
  }
}, 15000);

wss.on('close', () => clearInterval(heartbeatInterval));

server.listen(PORT, HOST, () => {
  console.log(`SkyDeck 737 Pro global multiplayer server listening on http://${HOST}:${PORT}`);
});
