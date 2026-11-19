/* multiplayer.js — drop-in SkyDeck global multiplayer client */
(function () {
  'use strict';

  const DEFAULT_CALLSIGN = 'PILOT' + Math.floor(100 + Math.random() * 900);

  const MP = {
    ws: null,
    playerId: null,
    joined: false,
    callsign: DEFAULT_CALLSIGN,
    modelId: '737',
    liveryIdx: 0,
    airport: 'LSZH',
    remote: new Map(),
    lastSend: 0,
    sendHz: 10,
    reconnectDelay: 1000,
    reconnectMax: 15000,
    reconnectTimer: null,
    enabled: false,
    hooks: {},
    _lastQ: null
  };

  const R_LAT = 111132;
  function mPerDegLon(lat) { return 111320 * Math.cos(lat * Math.PI / 180); }
  function worldToLL(x, z) {
    const o = (window.CFG && window.CFG.origin) || { lat: 47.4647, lon: 8.5492 };
    return { lat: o.lat - z / R_LAT, lon: o.lon + x / mPerDegLon(o.lat) };
  }
  function llToWorld(lat, lon) {
    const o = (window.CFG && window.CFG.origin) || { lat: 47.4647, lon: 8.5492 };
    return { x: (lon - o.lon) * mPerDegLon(o.lat), z: -(lat - o.lat) * R_LAT };
  }

  function readLocalState() {
    const p = window.plane || {};
    const pos = (p.pos || p.position || { x: 0, y: 0, z: 0 });
    const ll = worldToLL(pos.x || 0, pos.z || 0);

    let q = { x: 0, y: 0, z: 0, w: 1 };
    const qsrc = p.quat || p.quaternion || p.rotationQuaternion || (window.aircraftRoot && window.aircraftRoot.rotationQuaternion);
    if (qsrc && typeof qsrc.x === 'number') {
      q = { x: qsrc.x, y: qsrc.y, z: qsrc.z, w: qsrc.w };
    }

    const vel = p.vel || { x: 0, y: 0, z: 0 };
    const spd = Math.hypot(vel.x || 0, vel.y || 0, vel.z || 0);
    const hdg = ((Math.atan2(vel.x || 0, -(vel.z || 0)) * 180 / Math.PI) + 360) % 360;

    return {
      lat: ll.lat, lon: ll.lon, alt: pos.y || 0,
      qx: q.x, qy: q.y, qz: q.z, qw: q.w,
      spd, hdg, vs: (p.vs || 0), flying: !p.onGround && !!p.flying
    };
  }

  function labelTexture(callsign) {
    const scene = window.scene;
    const dt = new BABYLON.DynamicTexture('mpLabel_' + callsign, { width: 256, height: 64 }, scene, true);
    dt.hasAlpha = true;
    const ctx = dt.getContext();
    ctx.clearRect(0, 0, 256, 64);
    ctx.fillStyle = 'rgba(8,16,24,0.78)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = '#38d9ff';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, 253, 61);
    ctx.fillStyle = '#e8f6ff';
    ctx.font = 'bold 34px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(callsign, 128, 34);
    dt.update(false);
    return dt;
  }

  function createRemoteMesh(record) {
    const scene = window.scene;
    if (!scene) return null;
    const root = new BABYLON.TransformNode('mp_' + record.id, scene);
    root.rotationQuaternion = BABYLON.Quaternion.Identity();

    const bodyMat = new BABYLON.PBRMaterial('mpBody_' + record.id, scene);
    bodyMat.albedoColor = new BABYLON.Color3(0.92, 0.94, 0.97);
    bodyMat.metallic = 0.15; bodyMat.roughness = 0.4;

    const fuselage = BABYLON.MeshBuilder.CreateCylinder('mpF_' + record.id, { height: 34, diameterTop: 0.5, diameterBottom: 3.2, tessellation: 12 }, scene);
    fuselage.rotation.x = Math.PI / 2;
    fuselage.material = bodyMat;
    fuselage.parent = root;

    const wingMat = new BABYLON.PBRMaterial('mpWing_' + record.id, scene);
    wingMat.albedoColor = new BABYLON.Color3(0.7, 0.72, 0.75);

    const wing = BABYLON.MeshBuilder.CreateBox('mpW_' + record.id, { width: 34, height: 0.6, depth: 5 }, scene);
    wing.position.z = 1; wing.material = wingMat; wing.parent = root;

    const labelPlane = BABYLON.MeshBuilder.CreatePlane('mpLbl_' + record.id, { width: 8, height: 2 }, scene);
    const labelMat = new BABYLON.StandardMaterial('mpLblM_' + record.id, scene);
    labelMat.diffuseTexture = labelTexture(record.callsign || record.id);
    labelMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
    labelMat.disableLighting = true; labelMat.backFaceCulling = false;
    labelPlane.material = labelMat;
    labelPlane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    labelPlane.position.set(0, 10, 0); labelPlane.parent = root;

    root.setEnabled(false);
    return { root, labelPlane, labelMat };
  }

  function updateRemoteMesh(mesh, record) {
    if (!mesh || !mesh.root) return;
    const w = llToWorld(record.lat || 0, record.lon || 0);
    mesh.root.position.set(w.x, record.alt || 0, w.z);
    mesh.root.rotationQuaternion.copyFrom(new BABYLON.Quaternion(record.qx || 0, record.qy || 0, record.qz || 0, record.qw || 1));
    mesh.root.setEnabled(true);
  }

  function upsertRemote(record) {
    let entry = MP.remote.get(record.id);
    if (!entry) {
      entry = createRemoteMesh(record) || {};
      entry.record = record;
      MP.remote.set(record.id, entry);
    } else { entry.record = record; }
    updateRemoteMesh(entry, record);
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return window.MP_URL || (proto + '//' + location.host);
  }

  function connect() {
    if (!MP.enabled) return;
    try { if (MP.ws) MP.ws.close(); } catch (_) {}
    
    let ws;
    try { ws = new WebSocket(wsUrl()); } catch (err) { return; }
    MP.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', callsign: MP.callsign, state: readLocalState() }));
    };

    ws.onmessage = (ev) => {
      let data; try { data = JSON.parse(ev.data); } catch (_) { return; }
      if (data.type === 'welcome') {
        MP.joined = true;
        (data.players || []).forEach(upsertRemote);
      } else if (data.type === 'player:joined' || data.type === 'player:state') {
        if (data.player && data.player.id !== MP.playerId) upsertRemote(data.player);
      } else if (data.type === 'player:left') {
        const mesh = MP.remote.get(data.id);
        if (mesh && mesh.root) mesh.root.dispose();
        MP.remote.delete(data.id);
      }
    };

    ws.onclose = () => {
      MP.joined = false;
      setTimeout(connect, MP.reconnectDelay);
    };
  }

  MP.init = function (opts) {
    opts = opts || {};
    MP.enabled = true;
    connect();
    setInterval(() => {
      if (!MP.ws || MP.ws.readyState !== WebSocket.OPEN || !MP.joined) return;
      const now = performance.now();
      if (now - MP.lastSend < 1000 / MP.sendHz) return;
      MP.lastSend = now;
      try { MP.ws.send(JSON.stringify(Object.assign({ type: 'state' }, readLocalState()))); } catch (_) {}
    }, 50);
  };

  window.Multiplayer = MP;

  // Auto-start when the game is ready
  window.addEventListener('load', () => {
    let tries = 0;
    const boot = setInterval(() => {
      tries++;
      if (window.scene && window.plane) {
        clearInterval(boot);
        if (!MP.enabled) MP.init();
      } else if (tries > 200) clearInterval(boot);
    }, 100);
  });
})();