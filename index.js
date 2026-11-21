const crypto = require('crypto');

// ==========================================
// KONFIGURASI
// ==========================================
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const APP = "https://app.khaddavi.net";

// Polyfill Node.js
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;
if (!globalThis.btoa) globalThis.btoa = (str) => Buffer.from(str, 'binary').toString('base64');

// ==========================================
// HELPER
// ==========================================
class CookieJar {
    constructor() { this.jar = {}; }
    save(res) {
        let raw = res.headers.get('set-cookie');
        if (!raw) return;
        if (typeof raw === 'string') raw = raw.split(/,(?=[^;]+=[^;]+)/);
        raw.forEach(c => {
            const pair = c.split(";")[0];
            const i = pair.indexOf("=");
            if (i > 0) this.jar[pair.slice(0, i).trim()] = pair.slice(i + 1);
        });
    }
    getHeader() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join("; "); }
    get(key) { return this.jar[key]; }
}

async function makeToken(xsrf) {
    const fp = "webgl:1||audio:1||canvas:1||fonts:1||system:1||env:1||network:1";
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fp));
    const hex = Array.from(new Uint8Array(buf)).map((n) => n.toString(16).padStart(2, "0")).join("");
    const suffix = "#" + btoa(hex);
    return String(xsrf).slice(0, 128 - suffix.length) + suffix;
}

// ==========================================
// CORE LOGIC: BYPASS
// ==========================================
async function bypassSfl(input) {
    const code = String(input || "").trim()
        .replace(/^https?:\/\//i, "")
        .replace(/^(www\.)?sfl\.gl\//i, "")
        .replace(/\/+$/, "");
        
    if (!code) throw new Error("Kode/URL sfl.gl tidak valid");

    const jar = new CookieJar();
    const req = async (url, opts = {}) => {
        const res = await fetch(url, {
            ...opts,
            redirect: "manual",
            headers: { "user-agent": UA, ...opts.headers }
        });
        jar.save(res);
        return res;
    };

    let res = await req(`https://sfl.gl/${encodeURIComponent(code)}`, { headers: { accept: "application/json, text/html" } });
    let text = await res.text();
    
    let url, ray_id;
    try {
        const data = JSON.parse(text);
        url = data.url;
        ray_id = data.ray_id;
    } catch (e) {}

    if (!url || !ray_id) {
        const mForm = text.match(/<form[^>]+action="([^"]+)"/);
        const mRay = text.match(/name="ray_id"[^>]+value="([^"]+)"/);
        if (mForm && mRay) {
            url = mForm[1];
            ray_id = mRay[1];
        }
    }

    if (!url || !ray_id) throw new Error("Gagal mendapatkan url/ray_id dari sfl.gl");

    res = await req(`${url}?ray_id=${ray_id}`, { headers: { cookie: jar.getHeader() } });
    let loc = res.headers.get("location");
    if (!loc) throw new Error("redirect.php tidak mengembalikan location");
    let slug = new URL(loc, APP).href;

    const handshake = async (page) => {
        let view = await req(page, { headers: { cookie: jar.getHeader() } });
        let xsrf_raw = jar.get("XSRF-TOKEN") || "";
        if (!xsrf_raw) throw new Error("XSRF-TOKEN tidak ditemukan");

        let token = await makeToken(decodeURIComponent(xsrf_raw));
        let s = await req(APP + "/api/session", {
            method: "POST",
            headers: { cookie: jar.getHeader(), "content-type": "application/json", origin: APP, referer: page },
            body: JSON.stringify({ _token: token })
        });
        let sdata = await s.json().catch(() => ({}));
        if (sdata.captcha || sdata.passcode) throw new Error("Shortlink butuh captcha/passcode manual");

        const api = async (path, body) => {
            return req(APP + path, {
                method: "POST",
                headers: { cookie: jar.getHeader(), "content-type": "application/json", origin: APP, referer: page },
                body: JSON.stringify(body)
            });
        };
        return { step: sdata.step, api };
    };

    let stage = await handshake(slug);

    if (stage.step !== 2) {
        let verify = await stage.api("/api/verify", { _a: 0 });
        let vdata = await verify.json().catch(() => ({}));
        if (!vdata.target) throw new Error("Gagal verifikasi shortlink");
        
        res = await req(new URL(vdata.target, APP).href, { headers: { cookie: jar.getHeader(), referer: slug } });
        loc = res.headers.get("location");
        if (!loc) throw new Error("Verify tidak mengembalikan location");
        
        slug = new URL(loc, APP).href;
        stage = await handshake(slug);
    }

    let go = await stage.api("/api/go", { key: 42, size: "1600.900", ado: null });
    let gdata = await go.json().catch(() => ({}));
    let landing = gdata.url || gdata.target;
    if (!landing) throw new Error("Gagal mendapatkan URL tujuan");

    let final = await req(landing, { headers: { cookie: jar.getHeader(), referer: slug } });
    let finalLoc = final.headers.get("location");
    if (finalLoc) return new URL(finalLoc, landing).href;

    let body = await final.text();
    let match = body.match(/location\.href\s*=\s*["']([^"']+)["']/) || body.match(/location\.replace\(\s*["']([^"']+)["']/);
    
    if (match) return match[1].replace(/\\\//g, "/");
    return landing;
}

// ==========================================
// HANDLER VERCEL
// ==========================================
module.exports = async (req, res) => {
    // CORS biar bisa diakses dari mana aja
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") return res.status(200).end();

    // Ambil Target URL
    let targetUrl = req.query.url;
    if (req.method === "POST" && req.body) targetUrl = req.body.url || targetUrl;

    if (!targetUrl) {
        return res.status(400).json({ status: "error", message: "Parameter 'url' wajib diisi" });
    }

    // Eksekusi
    try {
        const finalUrl = await bypassSfl(targetUrl);
        return res.json({
            status: "success",
            original: targetUrl,
            bypass: finalUrl
        });
    } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
    }
};
