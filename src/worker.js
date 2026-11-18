import html from './index.html';

// --- общая физика (такая же в index.html) ---
const PX_PER_M = 40;
const GRAVITY = 1400;
const TOSS_SPEED = 720;
const MAX_SPEED = 2600;
const BOUNCE = 0.35;
const FRICTION = 0.6;
const STEP = 1 / 120;

function physStep(t, dt) {
  t.vy -= GRAVITY * dt;
  t.x += t.vx * dt;
  t.y += t.vy * dt;
  if (t.y <= 0) {
    t.y = 0;
    if (Math.abs(t.vy) > 120) {
      t.vy = -t.vy * BOUNCE;
      t.vx *= FRICTION;
    } else {
      t.vy = 0;
      t.vx *= Math.pow(0.02, dt);
      if (Math.abs(t.vx) < 8) return true;
    }
  }
  return false;
}

function simulate(y, vx, vy) {
  const t = { x: 0, y, vx, vy };
  let steps = 0;
  while (!physStep(t, STEP) && steps < 120 * 60) steps++;
  return { dist: Math.max(0, t.x / PX_PER_M), time: steps * STEP };
}

// --- комнаты ---
const MAX_PLAYERS = 4;
const ROUNDS = 3;
const TURN_MS = 30000;
const PEAK = (TOSS_SPEED * TOSS_SPEED) / (2 * GRAVITY);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clean = (s) => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16);

export class Room {
  constructor(state, env) {
    this.players = [];
    this.phase = 'lobby'; // lobby | playing | finished
    this.round = 0;
    this.turn = 0;
    this.busy = false;
    this.timer = null;
    this.deadline = 0;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const pid = String(url.searchParams.get('id') || '').slice(0, 40);
    const name = clean(url.searchParams.get('name'));
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    let p = pid && this.players.find((x) => x.id === pid);
    if (p) {
      if (p.ws) try { p.ws.close(1000, 'replaced'); } catch (e) {}
      p.ws = server;
      p.online = true;
      if (name) p.name = name;
    } else {
      const err = this.phase !== 'lobby' ? 'Игра уже идёт' : this.players.length >= MAX_PLAYERS ? 'Комната заполнена (максимум 4)' : null;
      if (err) {
        server.send(JSON.stringify({ type: 'error', msg: err }));
        server.close(1000, 'rejected');
        return new Response(null, { status: 101, webSocket: client });
      }
      p = { id: pid || crypto.randomUUID(), name: name || 'Игрок', score: 0, shots: [], ws: server, online: true };
      this.players.push(p);
    }

    server.addEventListener('message', (e) => this.onMsg(p, server, e.data));
    const bye = () => {
      if (p.ws !== server) return;
      p.ws = null;
      p.online = false;
      if (this.phase === 'lobby') {
        this.players = this.players.filter((x) => x !== p);
      } else if (this.phase === 'playing' && this.current() === p && !this.busy) {
        this.miss(p);
      }
      if (this.phase === 'playing' && !this.players.some((x) => x.online)) this.endGame();
      this.broadcast();
    };
    server.addEventListener('close', bye);
    server.addEventListener('error', bye);

    server.send(JSON.stringify({ type: 'hello', you: p.id }));
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  current() {
    return this.players[this.turn];
  }

  onMsg(p, ws, raw) {
    if (p.ws !== ws) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    const isHost = this.players[0] === p;
    const myTurn = this.phase === 'playing' && this.current() === p && !this.busy;

    if (m.type === 'start' && isHost && this.phase !== 'playing') {
      this.players = this.players.filter((x) => x.online);
      for (const x of this.players) { x.score = 0; x.shots = []; }
      this.phase = 'playing';
      this.round = 1;
      this.turn = 0;
      this.startTurn();
    } else if (m.type === 'toss' && myTurn) {
      this.send({ type: 'toss', id: p.id }, p);
    } else if (m.type === 'hit' && myTurn) {
      const y = Math.min(Math.max(num(m.y), 0), PEAK + 1);
      const vx = Math.min(Math.max(num(m.vx), 0), MAX_SPEED);
      let vy = Math.min(Math.max(num(m.vy), 0), MAX_SPEED + 150);
      const sp = Math.hypot(vx, vy);
      const k = sp > MAX_SPEED + 200 ? (MAX_SPEED + 200) / sp : 1;
      const shot = { y, vx: vx * k, vy: vy * k };
      const r = simulate(shot.y, shot.vx, shot.vy);
      const dist = Math.round(r.dist * 10) / 10;
      p.score = Math.round((p.score + dist) * 10) / 10;
      p.shots.push(dist);
      this.busy = true;
      this.clearTimer();
      this.send({ type: 'shot', id: p.id, ...shot, dist });
      this.broadcast();
      this.later(() => this.advance(), r.time * 1000 + 2000);
    } else if (m.type === 'miss' && myTurn) {
      this.miss(p);
    } else if (m.type === 'emoji' && typeof m.e === 'string') {
      this.send({ type: 'emoji', id: p.id, e: m.e.slice(0, 4) });
    }
  }

  miss(p) {
    p.shots.push(0);
    this.busy = true;
    this.clearTimer();
    this.send({ type: 'missed', id: p.id });
    this.broadcast();
    this.later(() => this.advance(), 1500);
  }

  startTurn() {
    this.busy = false;
    const p = this.current();
    this.clearTimer();
    if (!p.online) {
      this.deadline = Date.now() + 1500;
      this.later(() => this.miss(p), 1500);
    } else {
      this.deadline = Date.now() + TURN_MS;
      this.later(() => { if (this.current() === p && !this.busy) this.miss(p); }, TURN_MS);
    }
    this.broadcast();
  }

  advance() {
    if (this.phase !== 'playing') return;
    this.turn++;
    if (this.turn >= this.players.length) {
      this.turn = 0;
      this.round++;
      if (this.round > ROUNDS) return this.endGame();
    }
    this.startTurn();
  }

  endGame() {
    this.clearTimer();
    this.phase = 'finished';
    this.busy = false;
    this.broadcast();
  }

  later(fn, ms) {
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; fn(); }, ms);
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  send(obj, except) {
    const s = JSON.stringify(obj);
    for (const x of this.players) {
      if (x.ws && x !== except) try { x.ws.send(s); } catch (e) {}
    }
  }

  broadcast() {
    const cur = this.current();
    this.send({
      type: 'state',
      phase: this.phase,
      round: this.round,
      rounds: ROUNDS,
      turn: this.phase === 'playing' && cur ? cur.id : null,
      busy: this.busy,
      deadline: this.deadline,
      now: Date.now(),
      host: this.players[0] ? this.players[0].id : null,
      players: this.players.map((x) => ({ id: x.id, name: x.name, score: x.score, shots: x.shots, online: x.online })),
    });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/ws\/([A-Z0-9]{4})$/);
    if (m) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
    }
    if (url.pathname === '/manifest.webmanifest') {
      return new Response(JSON.stringify({
        name: 'Țurca', short_name: 'Țurca', start_url: '/', display: 'standalone',
        background_color: '#87c5ea', theme_color: '#87c5ea', orientation: 'landscape',
      }), { headers: { 'content-type': 'application/manifest+json' } });
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
    }
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    return new Response('Not found', { status: 404 });
  },
};
