require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const url = "https://pixai.art/en/generator/image";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
const isDocker = process.env.IS_DOCKER !== 'false';
const shotPath = "/data/";

function delay(time) { return new Promise((resolve) => setTimeout(resolve, time)); }

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
        decoded = Buffer.from(cookieStr, 'base64').toString('utf-8');
    }
    const lines = decoded.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    return lines.map(line => {
        const tabs = line.split('\t');
        return { name: tabs[5], value: tabs[6], domain: tabs[0], path: tabs[2] || '/' };
    }).filter(c => c.name && c.value !== undefined && c.domain);
}

async function isDailyClaimModalThere(page) {
    return await page.evaluate(() => document.body.innerText.includes('Daily Claim'));
}

async function isAlreadyClaimedState(page) {
    return await page.evaluate(() => {
        const text = document.body ? document.body.innerText : '';
        return /Next reward available/i.test(text) || /Credits claimed!/i.test(text);
    });
}

async function getTurnstileHostHandle(page) {
    let host = await page.$('#cf-turnstile');
    if (host) return host;
    const hiddenInput = await page.$('input[name="cf-turnstile-response"]');
    if (hiddenInput) {
        const parent = await hiddenInput.evaluateHandle(el => el.parentElement);
        return parent.asElement();
    }
    return null;
}

async function solveTurnstile(page) {
    console.log("[PROCESS] Locating Cloudflare verification host...");
    const host = await getTurnstileHostHandle(page);
    if (!host) return false;

    console.log("[AUTH] Turnstile host detected.");
    const box = await host.boundingBox();
    if (!box) return false;

    console.log(`[AUTH] Turnstile host box: x=${Math.round(box.x)}, y=${Math.round(box.y)}, w=${Math.round(box.width)}, h=${Math.round(box.height)}`);

    const targetX = box.x + Math.min(26, Math.max(18, box.width * 0.08));
    const targetY = box.y + (box.height / 2);

    console.log(`[AUTH] Turnstile click target: ${Math.round(targetX)}, ${Math.round(targetY)}`);
    await page.mouse.click(targetX, targetY, { delay: 100 });
    
    try {
        await page.waitForFunction(() => {
            const el = document.querySelector('input[name="cf-turnstile-response"]');
            return !!(el && el.value && el.value.trim().length > 0);
        }, { timeout: 15000 });
        console.log("[AUTH] Turnstile response detected.");
        return true;
    } catch (e) {
        return true; // Proceed anyway to check button status
    }
}

async function run() {
    console.log(`[INFO] Starting PixAI Auto-Claimer (Turnstile-Aware Mode)`);
    const browser = await puppeteer.launch({
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"] : []
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });
    
    try {
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
        const localCookies = await parseLocalCookies(COOKIE_STRING);
        await applyCookies(page, localCookies);

        console.log("[NAV] Moving to Generator...");
        await page.goto(url, { waitUntil: "networkidle2" });
        await delay(12000);

        if (!(await isDailyClaimModalThere(page))) {
            console.log(await isAlreadyClaimedState(page) ? "[INFO] Already claimed today." : "[INFO] Popup not detected. Likely already claimed.");
            return;
        }

        await solveTurnstile(page);
        console.log("[WAIT] Processing verification...");
        await delay(10000);

        const result = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const claimBtn = btns.find(b => /claim/i.test(b.innerText));
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