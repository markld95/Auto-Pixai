require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require('fs');
const axios = require('axios');
puppeteer.use(StealthPlugin());

const url = "https://pixai.art/en/generator/image";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
const FS_URL = process.env.FLARESOLVERR_URL || "";
const isDocker = process.env.IS_DOCKER !== 'false';
const LANG = process.env.APP_LANG || "en-GB";

// Saving directly to /data/ which you mapped to /mnt/user/appdata/auto-pixai
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
        } catch (e) { /* Skip malformed */ }
    }
}

async function parseLocalCookies(cookieStr) {
    if (!cookieStr) return [];
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
    console.log(`[INFO] Starting PixAI Auto-Claimer (Turnstile Precision Mode)`);
    const browser = await puppeteer.launch({ 
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", `--lang=${LANG}`] : []
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    await page.setUserAgent(UA);

    try {
        // 1. Initial Load & Login
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
        const localCookies = await parseLocalCookies(COOKIE_STRING);
        await applyCookies(page, localCookies);
        console.log(`[AUTH] Injected ${localCookies.length} user cookies.`);

        // 2. FlareSolverr (For initial bypass if needed)
        if (FS_URL) {
            try {
                const fsRes = await axios.post(FS_URL, { cmd: "sessions.create", url: "https://pixai.art", maxTimeout: 60000 });
                if (fsRes.data.solution) await applyCookies(page, fsRes.data.solution.cookies);
            } catch (e) { console.warn("[WARN] FlareSolverr skipped/failed."); }
        }

        // 3. Navigate to Generator and wait for Popup
        console.log("[NAV] Navigating to Generator...");
        await page.goto(url, { waitUntil: "networkidle2" });
        await delay(10000); 

        // BEFORE SCREENSHOT
        await page.screenshot({ path: `${shotPath}1_before_claim.png`, fullPage: true });

        // 4. Handle Cloudflare Turnstile inside the Popup
        console.log("[PROCESS] Hunting for Cloudflare Turnstile frame...");
        const frames = page.frames();
        const cfFrame = frames.find(f => f.url().includes('cloudflare') || f.url().includes('turnstile'));

        if (cfFrame) {
            console.log("[AUTH] Turnstile frame found. Attempting to click checkbox...");
            try {
                // Find the checkbox container inside the frame
                const checkbox = await cfFrame.waitForSelector('#challenge-stage', { timeout: 8000 });
                if (checkbox) {
                    const rect = await checkbox.boundingBox();
                    if (rect) {
                        // Use physical mouse click at coordinates
                        await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
                        console.log("[AUTH] Checkbox clicked. Waiting for validation...");
                        await delay(6000); // Wait for button to enable
                    }
                }
            } catch (e) {
                console.log("[INFO] Could not click checkbox (it may be auto-solving).");
            }
        }

        // 5. Click the "Claim" Button
        console.log("[PROCESS] Attempting to click the Claim button...");
        const claimResult = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const claimBtn = btns.find(b => b.innerText.toLowerCase().includes('claim 12,000'));
            if (claimBtn && !claimBtn.disabled) {
                claimBtn.click();
                return claimBtn.innerText.trim();
            }
            return null;
        });

        if (claimResult) {
            console.log(`[SUCCESS] Claimed: ${claimResult}`);
            await delay(5000);
        } else {
            console.log("[FAIL] Claim button was not found, not enabled, or already clicked.");
        }

        // AFTER SCREENSHOT
        await page.screenshot({ path: `${shotPath}2_after_claim.png`, fullPage: true });

    } catch (e) { console.error("[FATAL ERROR]", e.message); }
    finally { 
        await browser.close(); 
        console.log("[EXIT] Done."); 
    }
}

run();