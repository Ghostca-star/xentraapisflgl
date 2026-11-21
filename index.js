// Simpan sebagai app.js
// Jalanin: node app.js https://sfl.gl/xxx
// Atau:    node app.js https://sub2unlock.io/xxx

const crypto = require('crypto');

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const APP_KHADDAVI = "https://app.khaddavi.net";

if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;
if (!globalThis.btoa) globalThis.btoa = (str) => Buffer.from(str, 'binary').toString('base64');

// ==========================================
// HELPER: COOKIE JAR (Khusus SFL)
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
// ENGINE 1: SFL.GL
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
    let slug = new URL(loc, APP_KHADDAVI).href;

    const handshake = async (page) => {
        let view = await req(page, { headers: { cookie: jar.getHeader() } });
        let xsrf_raw = jar.get("XSRF-TOKEN") || "";
        if (!xsrf_raw) throw new Error("XSRF-TOKEN tidak ditemukan");

        let token = await makeToken(decodeURIComponent(xsrf_raw));
        let s = await req(APP_KHADDAVI + "/api/session", {
            method: "POST",
            headers: { cookie: jar.getHeader(), "content-type": "application/json", origin: APP_KHADDAVI, referer: page },
            body: JSON.stringify({ _token: token })
        });
        let sdata = await s.json().catch(() => ({}));
        if (sdata.captcha || sdata.passcode) throw new Error("Shortlink butuh captcha/passcode manual");

        const api = async (path, body) => {
            return req(APP_KHADDAVI + path, {
                method: "POST",
                headers: { cookie: jar.getHeader(), "content-type": "application/json", origin: APP_KHADDAVI, referer: page },
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
        
        res = await req(new URL(vdata.target, APP_KHADDAVI).href, { headers: { cookie: jar.getHeader(), referer: slug } });
        loc = res.headers.get("location");
        if (!loc) throw new Error("Verify tidak mengembalikan location");
        
        slug = new URL(loc, APP_KHADDAVI).href;
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
// ENGINE 2: SUB2UNLOCK & SUB4UNLOCK (FIXED)
// ==========================================
async function bypassSubUnlock(inputUrl) {
    const response = await fetch(inputUrl, {
        headers: {
            "user-agent": UA,
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
        }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} saat fetch target`);
    
    const html = await response.text();
    
    const blacklist = [
        "fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com",
        "google.com", "googleapis.com", "gstatic.com", "cloudflare.com",
        "bootstrapcdn.com", "jquery.com", "w3.org", "schema.org",
        "sub2unlock", "sub4unlock", "link2unlock"
    ];

    const isClean = (url) => !blacklist.some(b => url.includes(b));

    let matches = html.match(/<a[^>]+class=["'][^"']*get-link[^"']*["'][^>]+href=["']([^"']+)["']/gi);
    if (matches) {
        for (let m of matches) {
            let link = m.match(/href=["']([^"']+)["']/i);
            if (link && isClean(link[1])) return link[1].replace(/&amp;/g, '&');
        }
    }
    
    matches = html.match(/<a[^>]+href=["']([^"']+)["'][^>]+class=["'][^"']*get-link[^"']*["']/gi);
    if (matches) {
        for (let m of matches) {
            let link = m.match(/href=["']([^"']+)["']/i);
            if (link && isClean(link[1])) return link[1].replace(/&amp;/g, '&');
        }
    }

    matches = html.match(/href=["'](https?:\/\/[^"']+)["']/gi);
    if (matches) {
        for (let m of matches) {
            let link = m.match(/href=["']([^"']+)["']/i);
            if (link && isClean(link[1])) {
                return link[1].replace(/&amp;/g, '&');
            }
        }
    }

    throw new Error("Link target asli tidak ditemukan di HTML statis. Kemungkinan target butuh eksekusi JavaScript/social action.");
}

// ==========================================
// CLI RUNNER
// ==========================================
(async () => {
    const url = process.argv[2];
    if (!url) {
        console.log("Usage: node app.js <URL>");
        console.log("Contoh: node app.js https://sfl.gl/GnE1");
        console.log("        node app.js https://sub2unlock.io/1aFLf");
        process.exit(1);
    }

    let mode = "auto";
    if (url.includes("sfl.gl")) mode = "sfl";
    else if (url.includes("sub2unlock") || url.includes("sub4unlock")) mode = "unlock";

    console.log(`[*] Mode: ${mode.toUpperCase()}`);
    console.log(`[*] Target: ${url}`);
    console.log(`[*] Memproses...\n`);

    try {
        let result;
        if (mode === "sfl") {
            result = await bypassSfl(url);
        } else if (mode === "unlock") {
            result = await bypassSubUnlock(url);
        } else {
            throw new Error("Domain tidak dikenal. Gunakan sfl.gl, sub2unlock.io, atau sub4unlock.co");
        }

        console.log(`[✓] BERHASIL!`);
        console.log(`[✓] TARGET URL: ${result}`);
    } catch (error) {
        console.error(`[!] GAGAL: ${error.message}`);
    }
})();
