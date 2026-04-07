require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require('fs');
puppeteer.use(StealthPlugin());

const url = "https://pixai.art/en/generator/image";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
const isDocker = process.env.IS_DOCKER !== 'false';
const LANG = process.env.APP_LANG || "en-GB";

const shotDir = '/screenshots';
if (isDocker && !fs.existsSync(shotDir)) {
    fs.mkdirSync(shotDir, { recursive: true });
}

function delay(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
}

async function applyCookies(page) {
    if (!COOKIE_STRING) return;
    let decoded = COOKIE_STRING;
    if (!COOKIE_STRING.includes('\t') && !COOKIE_STRING.includes('=')) {
        decoded = Buffer.from(COOKIE_STRING, 'base64').toString('utf-8');
    }
    const lines = decoded.split('\n');
    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        const tabs = line.split('\t');
        if (tabs.length >= 7) {
            const [domain, , path, secure, , name, value] = tabs;
            await page.setCookie({
                name: name.trim(), value: value.trim(),
                domain: domain.startsWith('.') ? domain : `.${domain}`,
                path: path, secure: secure.toUpperCase() === 'TRUE', sameSite: 'Lax'
            });
        }
    }
}

async function run() {
    console.log("[INFO] Starting PixAI Auto-Claimer (Cloudflare-Solver Mode)...");
    const browser = await puppeteer.launch({ 
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"] : []
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    try {
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
        await applyCookies(page);
        console.log("[NAV] Navigating to Generator...");
        await page.goto(url, { waitUntil: "networkidle2" });
        await delay(8000);

        // --- STEP 1: BEFORE SCREENSHOT ---
        if (isDocker) await page.screenshot({ path: `${shotDir}/1_before_claim.png`, fullPage: true });

        // --- STEP 2: CLOUDFLARE CHECK ---
        console.log("[PROCESS] Checking for Cloudflare checkbox...");
        const cfHandled = await page.evaluate(async () => {
            const iframe = document.querySelector('iframe[src*="cloudflare"]');
            if (iframe) {
                const rect = iframe.getBoundingClientRect();
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            }
            return null;
        });

        if (cfHandled) {
            console.log("[AUTH] Cloudflare detected. Attempting to click checkbox...");
            await page.mouse.click(cfHandled.x, cfHandled.y);
            await delay(5000); // Wait for Cloudflare to turn green
        }

        // --- STEP 3: CLAIM LOOP ---
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

        // --- STEP 4: AFTER SCREENSHOT ---
        if (isDocker) await page.screenshot({ path: `${shotDir}/2_after_claim.png`, fullPage: true });

    } catch (e) { console.error("[ERROR]", e.message); }
    finally { await browser.close(); console.log("[EXIT] Done."); }
}
run();