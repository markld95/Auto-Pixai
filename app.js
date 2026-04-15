require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const url = "https://pixai.art/en/generator/image";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
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

// --- FIXED COOKIE PARSER ---
async function parseLocalCookies(cookieStr) {
    if (!cookieStr) return [];
    let decoded = cookieStr;

    // Check if it's Base64
    if (!cookieStr.includes('\t') && !cookieStr.includes('=')) {
        try {
            decoded = Buffer.from(cookieStr, 'base64').toString('utf-8');
        } catch (e) {
            console.log("[ERROR] Failed to decode Base64 cookies.");
            return [];
        }
    }

    const lines = decoded.split('\n');
    const cookies = [];

    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;

        const tabs = line.split(/\t+/); // Split by one or more tabs
        if (tabs.length >= 7) {
            // Standard Netscape Format
            cookies.push({
                domain: tabs[0],
                path: tabs[2],
                name: tabs[5],
                value: tabs[6]
            });
        } else if (tabs.length >= 2) {
            // Fallback for simple key=value pairs if present
            cookies.push({
                domain: ".pixai.art",
                path: "/",
                name: tabs[tabs.length - 2],
                value: tabs[tabs.length - 1]
            });
        }
    }
    return cookies;
}

async function isDailyClaimModalThere(page) {
    return await page.evaluate(() => {
        const text = document.body ? document.body.innerText : '';
        return text.includes('Daily Claim') || text.includes('Reward');
    });
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
    const verifyRow = await page.evaluateHandle(() => {
        return Array.from(document.querySelectorAll('body *'))
            .find(el => /verify you are human/i.test(el.innerText || '')) || null;
    });
    return verifyRow.asElement();
}

async function solveTurnstile(page) {
    console.log("[PROCESS] Locating Cloudflare verification host...");
    const host = await getTurnstileHostHandle(page);
    if (!host) return false;

    const box = await host.boundingBox();
    if (!box) return false;

    const targetX = box.x + Math.min(26, Math.max(18, box.width * 0.08));
    const targetY = box.y + (box.height / 2);

    await page.mouse.move(targetX - 12, targetY - 6, { steps: 12 });
    await delay(100);
    await page.mouse.click(targetX, targetY, { delay: 100 });

    try {
        await page.waitForFunction(() => {
            const el = document.querySelector('input[name="cf-turnstile-response"]');
            return !!(el && el.value && el.value.trim().length > 0);
        }, { timeout: 15000 });
        console.log("[AUTH] Turnstile response detected.");
        return true;
    } catch (e) {
        return true; 
    }
}

async function run() {
    console.log(`[INFO] Starting PixAI Auto-Claimer (Cookie Fix Mode)`);

    const browser = await puppeteer.launch({
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? [
            "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled", "--window-size=1280,1024"
        ] : []
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });

    try {
        // Initial load to set domain
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });

        const localCookies = await parseLocalCookies(COOKIE_STRING);
        console.log(`[INFO] Parsed ${localCookies.length} cookies from PIXAI_COOKIE.`);
        
        if (localCookies.length === 0) {
            console.log("[ERROR] Cookie parsing failed. Check your Base64 string.");
        }

        await applyCookies(page, localCookies);

        console.log("[NAV] Moving to Generator...");
        await page.goto(url, { waitUntil: "networkidle2" });

        // Wait for page to settle and snap debug shot
        await delay(10000);
        await page.screenshot({ path: `${shotPath}debug_initial_load.png` });

        const modalPresent = await isDailyClaimModalThere(page);
        const claimed = await isAlreadyClaimedState(page);
        const isLoggedIn = await page.evaluate(() => document.body.innerText.includes('Credits'));

        if (!modalPresent) {
            if (!isLoggedIn) {
                console.log("[ERROR] Bot is LOGGED OUT. Refresh your PIXAI_COOKIE.");
            } else if (claimed) {
                console.log("[INFO] Already claimed today.");
            } else {
                console.log("[INFO] Popup not detected. Likely already claimed.");
            }
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