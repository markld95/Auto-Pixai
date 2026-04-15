require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const url = "https://pixai.art/en/generator/image";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
const LOGINNAME = process.env.LOGINNAME || "";
const PASSWORD = process.env.PASSWORD || "";
const isDocker = process.env.IS_DOCKER !== 'false';
const shotPath = "/data/";

function delay(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
}

async function applyCookies(page, cookiesArray) {
    for (const cookie of cookiesArray) {
        try {
            await page.setCookie({
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`,
                path: cookie.path || '/',
                secure: true,
                sameSite: 'Lax'
            });
        } catch (e) {}
    }
}

async function parseLocalCookies(cookieStr) {
    if (!cookieStr) return [];
    let decoded = cookieStr;
    if (!cookieStr.includes('\t') && !cookieStr.includes('=')) {
        try {
            decoded = Buffer.from(cookieStr, 'base64').toString('utf-8');
        } catch (e) {
            console.log("[ERROR] Cookie decoding failed.");
            return [];
        }
    }
    const lines = decoded.split('\n');
    const cookies = [];
    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        const tabs = line.split(/\t+/);
        if (tabs.length >= 7) {
            cookies.push({ domain: tabs[0], path: tabs[2], name: tabs[5], value: tabs[6] });
        }
    }
    return cookies;
}

async function performLogin(page) {
    console.log("[AUTH] Attempting credential login...");
    try {
        await page.goto("https://pixai.art/login", { waitUntil: "networkidle2" });
        await delay(2000);
        
        // Find email/username field
        await page.type('input[autocomplete="username"], input[type="email"], input[name="email"]', LOGINNAME, { delay: 50 });
        await page.type('input[type="password"]', PASSWORD, { delay: 50 });
        
        // Click Login Button
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const loginBtn = btns.find(b => /log in|sign in/i.test(b.innerText));
            if (loginBtn) loginBtn.click();
        });
        
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
        console.log("[AUTH] Login form submitted.");
        return true;
    } catch (e) {
        console.log("[ERROR] Login failed:", e.message);
        return false;
    }
}

async function solveTurnstile(page) {
    console.log("[PROCESS] Locating Cloudflare verification host...");
    const host = await page.evaluateHandle(() => {
        return document.querySelector('#cf-turnstile') || 
               Array.from(document.querySelectorAll('body *')).find(el => /verify you are human/i.test(el.innerText)) || 
               null;
    });

    const element = host.asElement();
    if (!element) return false;

    const box = await element.boundingBox();
    if (!box) return false;

    const targetX = box.x + Math.min(26, Math.max(18, box.width * 0.08));
    const targetY = box.y + (box.height / 2);

    await page.mouse.click(targetX, targetY, { delay: 100 });
    console.log("[AUTH] Verification click sent.");
    
    try {
        await page.waitForFunction(() => {
            const el = document.querySelector('input[name="cf-turnstile-response"]');
            return !!(el && el.value && el.value.trim().length > 0);
        }, { timeout: 15000 });
        return true;
    } catch (e) {
        return true; 
    }
}

async function run() {
    console.log(`[INFO] Starting PixAI Auto-Claimer (Cookie + Login Fallback)`);

    const browser = await puppeteer.launch({
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"] : []
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });

    try {
        // --- STEP 1: COOKIE ATTEMPT ---
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
        const localCookies = await parseLocalCookies(COOKIE_STRING);
        console.log(`[INFO] Parsed ${localCookies.length} cookies.`);
        if (localCookies.length > 0) {
            await applyCookies(page, localCookies);
            await page.goto(url, { waitUntil: "networkidle2" });
        }

        await delay(5000);
        let isLoggedIn = await page.evaluate(() => document.body.innerText.includes('Credits') || !document.body.innerText.includes('Log In'));

        // --- STEP 2: LOGIN FALLBACK ---
        if (!isLoggedIn && LOGINNAME && PASSWORD) {
            console.log("[INFO] Session invalid. Falling back to credentials...");
            const loginSuccess = await performLogin(page);
            if (loginSuccess) {
                await page.goto(url, { waitUntil: "networkidle2" });
                await delay(5000);
            }
        }

        await page.screenshot({ path: `${shotPath}debug_initial_load.png` });

        // --- STEP 3: CLAIM LOGIC ---
        const pageText = await page.evaluate(() => document.body.innerText);
        const modalPresent = pageText.includes('Daily Claim') || pageText.includes('Reward');
        const alreadyClaimed = /Next reward available/i.test(pageText) || /Credits claimed!/i.test(pageText);

        if (!modalPresent) {
            console.log(alreadyClaimed ? "[INFO] Already claimed today." : "[INFO] Popup not detected. Check debug_initial_load.png");
            return;
        }

        await solveTurnstile(page);
        await delay(10000);

        const result = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const claimBtn = btns.find(b => /claim/i.test(b.innerText) || /\d+,000/.test(b.innerText));
            if (claimBtn && !claimBtn.disabled) {
                claimBtn.click();
                return "SUCCESS";
            }
            return claimBtn ? "STILL_DISABLED" : "NOT_FOUND";
        });

        console.log(`[RESULT] Claim Status: ${result}`);
        await delay(2000);
        await page.screenshot({ path: `${shotPath}2_after_claim.png` });

    } catch (e) {
        console.error("[FATAL ERROR]", e.message);
    } finally {
        await browser.close();
        console.log("[EXIT] Done.");
    }
}

run();