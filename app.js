require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require('fs');
const axios = require('axios'); // Note: You may need to add axios to your package.json
puppeteer.use(StealthPlugin());

const url = "https://pixai.art/en/generator/image";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
const FS_URL = process.env.FLARESOLVERR_URL || ""; // e.g. http://192.168.1.X:8191/v1
const isDocker = process.env.IS_DOCKER !== 'false';
const LANG = process.env.APP_LANG || "en-GB";

const shotDir = '/screenshots';
if (isDocker && !fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });

function delay(time) { return new Promise((resolve) => setTimeout(resolve, time)); }

async function applyCookies(page, cookiesArray) {
    for (const cookie of cookiesArray) {
        await page.setCookie({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`,
            path: cookie.path || '/',
            secure: true,
            sameSite: 'Lax'
        });
    }
}

async function parseLocalCookies(cookieStr) {
    let decoded = cookieStr;
    if (!cookieStr.includes('\t') && !cookieStr.includes('=')) {
        decoded = Buffer.from(cookieStr, 'base64').toString('utf-8');
    }
    const lines = decoded.split('\n');
    const parsed = [];
    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        const tabs = line.split('\t');
        if (tabs.length >= 7) {
            parsed.push({ name: tabs[5], value: tabs[6], domain: tabs[0], path: tabs[2] });
        }
    }
    return parsed;
}

async function run() {
    console.log("[INFO] Starting PixAI Auto-Claimer (Hybrid FS Mode)...");
    const browser = await puppeteer.launch({ 
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"] : []
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    await page.setUserAgent(UA);

    try {
        // 1. Initial Load & Cookie Injection
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
        const localCookies = await parseLocalCookies(COOKIE_STRING);
        await applyCookies(page, localCookies);
        console.log(`[AUTH] Injected ${localCookies.length} user cookies.`);

        // 2. Optional FlareSolverr Logic
        if (FS_URL) {
            console.log("[PROXY] FlareSolverr URL found. Requesting clearance...");
            try {
                const fsRes = await axios.post(FS_URL, {
                    cmd: "sessions.create", url: "https://pixai.art", maxTimeout: 60000
                }, { timeout: 65000 });
                if (fsRes.data.solution) {
                    await applyCookies(page, fsRes.data.solution.cookies);
                    console.log("[PROXY] FlareSolverr clearance applied.");
                }
            } catch (e) { console.warn("[WARN] FlareSolverr failed, falling back to manual click."); }
        }

        console.log("[NAV] Navigating to Generator...");
        await page.goto(url, { waitUntil: "networkidle2" });
        await delay(8000);

        if (isDocker) await page.screenshot({ path: `${shotDir}/1_before_claim.png` });

        // 3. Cloudflare Turnstile Manual Fallback
        const cfFrame = page.frames().find(f => f.url().includes('cloudflare'));
        if (cfFrame) {
            console.log("[AUTH] Cloudflare Turnstile detected. Attempting precision click...");
            try {
                const box = await cfFrame.waitForSelector('#challenge-stage', { timeout: 5000 });
                const rect = await box.boundingBox();
                if (rect) {
                    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
                    await delay(6000);
                }
            } catch (e) { console.log("[INFO] Could not click CF box, might already be solved."); }
        }

        // 4. Claim Loop
        let claimed = false;
        for (let i = 0; i < 10; i++) {
            console.log(`[PROCESS] Attempt ${i + 1}/10...`);
            const result = await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('button, div[role="button"], span'));
                const btn = elements.find(el => {
                    const t = el.innerText.toLowerCase();
                    return ['claim', 'get', 'receive'].some(k => t.includes(k)) && 
                           el.offsetWidth > 0 && !t.includes('invite') && /\d/.test(t);
                });
                if (btn) { btn.click(); return btn.innerText.trim(); }
                return null;
            });

            if (result) {
                console.log(`[SUCCESS] Clicked: "${result}"`);
                claimed = true;
                await delay(5000);
                break;
            }
            await delay(3000);
        }

        if (isDocker) await page.screenshot({ path: `${shotDir}/2_after_claim.png` });

    } catch (e) { console.error("[ERROR]", e.message); }
    finally { await browser.close(); console.log("[EXIT] Done."); }
}
run();