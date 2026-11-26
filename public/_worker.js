// moojez.me — Cloudflare Pages worker (advanced mode) + D1
// Bindings: DB (D1 database). Secret: ADMIN_CODE (كود صفحة الإدارة، لا ينحط في المستودع)
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
let ready = null;

function init(env) {
  if (!ready) ready = env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, coins INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS players_coins ON players (coins DESC, updated ASC)"),
  ]).catch((e) => { ready = null; throw e; });
  return ready;
}

const clip = (v, n) => String(v == null ? "" : v).slice(0, n);
function cleanName(v) {
  const n = clip(v, 60).replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim();
  return n.length >= 2 && n.length <= 20 ? n : null;
}
function cleanPhone(v) {
  let d = clip(v, 30).replace(/[٠-٩]/g, (c) => "٠١٢٣٤٥٦٧٨٩".indexOf(c)).replace(/\D/g, "");
  if (/^9665\d{8}$/.test(d)) d = "0" + d.slice(3);
  if (/^5\d{8}$/.test(d)) d = "0" + d;
  return /^05\d{8}$/.test(d) ? d : null;
}
function same(a, b) { a = String(a); b = String(b); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; }
const byToken = (env, t) => env.DB.prepare("SELECT * FROM players WHERE token=?").bind(clip(t, 40)).first();

async function api(request, env, url) {
  if (!env.DB) return J({ error: "no_db" }, 500);
  await init(env);
  const p = url.pathname, m = request.method;

  if (p === "/api/ping") return J({ ok: true });

  if (p === "/api/board" && m === "GET") {
    const top = await env.DB.prepare("SELECT name, coins, token FROM players ORDER BY coins DESC, updated ASC LIMIT 50").all();
    const tok = clip(url.searchParams.get("token"), 40);
    const rows = top.results.map((r, i) => ({ rank: i + 1, name: r.name, coins: r.coins, me: !!tok && r.token === tok }));
    if (tok && !rows.some((r) => r.me)) {
      const me = await byToken(env, tok);
      if (me) {
        const ahead = await env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE coins > ? OR (coins = ? AND updated < ?)").bind(me.coins, me.coins, me.updated).first();
        rows.push({ rank: ahead.n + 1, name: me.name, coins: me.coins, me: true });
      }
    }
    return J({ ok: true, rows });
  }

  if (p === "/api/admin" && m === "GET") {
    const code = request.headers.get("x-admin-code") || "";
    if (!env.ADMIN_CODE) return J({ error: "no_admin" }, 503);
    if (!same(code, env.ADMIN_CODE)) { await new Promise((r) => setTimeout(r, 800)); return J({ error: "denied" }, 403); }
    const all = await env.DB.prepare("SELECT id, name, phone, coins, created, updated FROM players ORDER BY coins DESC, updated ASC").all();
    return J({ ok: true, players: all.results });
  }

  if (m !== "POST") return J({ error: "not_found" }, 404);
  if (!(request.headers.get("content-type") || "").includes("application/json")) return J({ error: "bad_type" }, 415);
  let b; try { b = await request.json(); } catch { return J({ error: "bad_json" }, 400); }
  if (!b || typeof b !== "object") return J({ error: "bad_json" }, 400);

  if (p === "/api/register") {
    const name = cleanName(b.name), phone = cleanPhone(b.phone);
    if (!name) return J({ error: "BAD_NAME" }, 400);
    if (!phone) return J({ error: "BAD_PHONE" }, 400);
    const old = await env.DB.prepare("SELECT * FROM players WHERE phone=?").bind(phone).first();
    if (old) {
      // نفس الرقم ونفس الاسم = نفس الطالب رجع من جهاز ثاني
      if (old.name.toLowerCase() === name.toLowerCase()) return J({ ok: true, token: old.token, name: old.name, coins: old.coins });
      return J({ error: "PHONE_TAKEN" }, 409);
    }
    const token = crypto.randomUUID(), t = Date.now();
    await env.DB.prepare("INSERT INTO players (token, name, phone, coins, created, updated) VALUES (?,?,?,0,?,?)").bind(token, name, phone, t, t).run();
    return J({ ok: true, token, name, coins: 0 });
  }

  if (p === "/api/coins") {
    const me = await byToken(env, b.token);
    if (!me) return J({ error: "NO_PLAYER" }, 404);
    const want = Math.max(0, Math.floor(Number(b.coins) || 0)), now = Date.now();
    // ما تنقص أبداً، والزيادة لها حد حسب الوقت (15 كل 3 ثواني) عشان يصعب الغش
    const max = me.coins + 15 * (1 + Math.floor((now - me.updated) / 3000));
    const coins = Math.max(me.coins, Math.min(want, max));
    if (coins !== me.coins) await env.DB.prepare("UPDATE players SET coins=?, updated=? WHERE id=?").bind(coins, now, me.id).run();
    return J({ ok: true, coins });
  }

  if (p === "/api/rename") {
    const name = cleanName(b.name);
    if (!name) return J({ error: "BAD_NAME" }, 400);
    const me = await byToken(env, b.token);
    if (!me) return J({ error: "NO_PLAYER" }, 404);
    await env.DB.prepare("UPDATE players SET name=? WHERE id=?").bind(name, me.id).run();
    return J({ ok: true, name });
  }
  return J({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env, url); } catch (e) { return J({ error: "server" }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
};
