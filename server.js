const http = require('http');
const express = require('express');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

app.use(express.static(path.resolve(__dirname), {
  index: 'index.html',
  extensions: ['html']
}));

// Authoritative multiplayer room registry: Map<roomId, Map<playerId, PlayerRecord>>
const rooms = new Map();
let nextSeq = 1;

function cleanRoom(raw) {
  const s = String(raw || 'PUBLIC').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16);
  return s || 'PUBLIC';
}

function cleanCallsign(raw, fallback) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9 _-]/g, '').trim().slice(0, 14);
  return s || fallback;
}

function getRoom(roomId) {
  let r = rooms.get(roomId);
  if (!r) {
    r = new Map();
    rooms.set(roomId, r);
  }
  return r;
}

function serializePlayer(p) {
  return {
    id: p.id,
    callsign: p.callsign,
    room: p.room,
    modelId: p.modelId,
    liveryIdx: p.liveryIdx,
    airport: p.airport,
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

function broadcastRoom(roomId, payload, excludeId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const msg = JSON.stringify(payload);
  for (const p of room.values()) {
    if (excludeId && p.id === excludeId) continue;
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      try {
        p.ws.send(msg);
      } catch (_) {}
    }
  }
}

function removeFromRoom(player) {
  if (!player || !player.room) return;
  const room = rooms.get(player.room);
  if (!room) return;
  const existed = room.delete(player.id);
  if (existed) {
    broadcastRoom(player.room, { type: 'player:left', id: player.id }, player.id);
    if (room.size === 0) rooms.delete(player.room);
  }
  player.room = null;
}

app.get('/health', (_req, res) => {
  let totalPlayers = 0;
  for (const r of rooms.values()) totalPlayers += r.size;
  res.status(200).json({ ok: true, rooms: rooms.size, players: totalPlayers });
});

app.get('/api/rooms', (_req, res) => {
  const list = [];
  for (const [id, r] of rooms.entries()) {
    list.push({ id, players: r.size });
  }
  res.status(200).json({ rooms: list });
});

app.use((_req, res) => {
  res.sendFile(path.resolve(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const playerId = 'P' + (nextSeq++).toString(36).toUpperCase();
  const player = {
    id: playerId,
    ws,
    isAlive: true,
    room: null,
    callsign: 'PILOT-' + playerId,
    modelId: '737',
    liveryIdx: 0,
    airport: 'LSZH',
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

    if (data.type === 'ping') {
      player.isAlive = true;
      try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch (_) {}
      return;
    }

    if (data.type === 'join') {
      const targetRoom = cleanRoom(data.room);
      const targetCallsign = cleanCallsign(data.callsign, player.callsign);
      const prevRoom = player.room;

      if (prevRoom && prevRoom !== targetRoom) {
        removeFromRoom(player);
      }

      player.callsign = targetCallsign;
      if (typeof data.modelId === 'string') player.modelId = data.modelId.slice(0, 24);
      if (Number.isFinite(data.liveryIdx)) player.liveryIdx = Math.max(0, data.liveryIdx | 0);
      if (typeof data.airport === 'string') player.airport = data.airport.slice(0, 12);
      if (data.state && typeof data.state === 'object') applyTelemetry(player, data.state);

      player.room = targetRoom;
      player.updatedAt = Date.now();
      const room = getRoom(targetRoom);
      const others = [];
      for (const other of room.values()) {
        if (other.id !== player.id) others.push(serializePlayer(other));
      }
      room.set(player.id, player);

      try {
        ws.send(JSON.stringify({
          type: 'welcome',
          playerId: player.id,
          room: targetRoom,
          callsign: player.callsign,
          players: others
        }));
      } catch (_) {}

      broadcastRoom(targetRoom, {
        type: 'player:joined',
        player: serializePlayer(player)
      }, player.id);
      return;
    }

    if (!player.room) return;

    if (data.type === 'state') {
      applyTelemetry(player, data);
      player.updatedAt = Date.now();
      broadcastRoom(player.room, {
        type: 'player:state',
        player: serializePlayer(player)
      }, player.id);
      return;
    }

    if (data.type === 'chat') {
      const text = String(data.text || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 140);
      if (!text) return;
      broadcastRoom(player.room, {
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
      broadcastRoom(player.room, {
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

  ws.on('close', () => {
    removeFromRoom(player);
  });

  ws.on('error', () => {
    removeFromRoom(player);
  });
});

function applyTelemetry(player, d) {
  const num = (v, fb) => (Number.isFinite(v) ? v : fb);
  player.lat = num(d.lat, player.lat);
  player.lon = num(d.lon, player.lon);
  player.alt = num(d.alt, player.alt);
  player.qx = num(d.qx, player.qx);
  player.qy = num(d.qy, player.qy);
  player.qz = num(d.qz, player.qz);
  player.qw = num(d.qw, player.qw);
  player.spd = num(d.spd, player.spd);
  player.hdg = num(d.hdg, player.hdg);
  player.vs = num(d.vs, player.vs);
  player.gearPos = num(d.gearPos, player.gearPos);
  player.flaps = num(d.flaps, player.flaps);
  player.throttle = num(d.throttle, player.throttle);
  player.crashed = !!d.crashed;
  if (typeof d.modelId === 'string') player.modelId = d.modelId.slice(0, 24);
  if (Number.isFinite(d.liveryIdx)) player.liveryIdx = Math.max(0, d.liveryIdx | 0);
  if (typeof d.airport === 'string') player.airport = d.airport.slice(0, 12);
  if (typeof d.callsign === 'string') player.callsign = cleanCallsign(d.callsign, player.callsign);
}

// Heartbeat & stale socket cleanup every 15s
const heartbeatInterval = setInterval(() => {
  for (const room of rooms.values()) {
    for (const player of room.values()) {
      if (!player.ws || player.ws.readyState !== WebSocket.OPEN) {
        removeFromRoom(player);
        continue;
      }
      if (!player.isAlive) {
        try { player.ws.terminate(); } catch (_) {}
        removeFromRoom(player);
        continue;
      }
      player.isAlive = false;
      try { player.ws.ping(); } catch (_) {}
    }
  }
}, 15000);

wss.on('close', () => clearInterval(heartbeatInterval));

server.listen(PORT, HOST, () => {
  console.log(`SkyDeck 737 Pro listening on http://${HOST}:${PORT}`);
});

