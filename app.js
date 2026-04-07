require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const axios = require('axios');
puppeteer.use(StealthPlugin());

const url = "https://pixai.art/en/generator/image";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
const FS_URL = process.env.FLARESOLVERR_URL || "";
const isDocker = process.env.IS_DOCKER !== 'false';
const LANG = process.env.APP_LANG || "en-GB";
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
        } catch (e) { }
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
    console.log(`[INFO] Starting PixAI Auto-Claimer (Aria-Targeting Mode)`);
    const browser = await puppeteer.launch({ 
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", `--lang=${LANG}`] : []
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    try {
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
        const localCookies = await parseLocalCookies(COOKIE_STRING);
        await applyCookies(page, localCookies);

        console.log("[NAV] Navigating to Generator...");
        await page.goto(url, { waitUntil: "networkidle2" });
        await delay(15000); 

        await page.screenshot({ path: `${shotPath}1_before_claim.png`, fullPage: true });

        // --- NEW: ARIA SEARCH ---
        console.log("[PROCESS] Searching for element with label 'Verify you are human'...");
        try {
            // Find the element by its accessibility label
            const turnstile = await page.waitForSelector('aria/Verify you are human', { timeout: 10000 });
            
            if (turnstile) {
                const rect = await turnstile.boundingBox();
                if (rect) {
                    console.log(`[AUTH] Aria Target found at (${Math.round(rect.x)}, ${Math.round(rect.y)}). Clicking...`);
                    
                    // The checkbox is usually 25-35 pixels to the LEFT of the center of the text
                    const clickX = rect.x + 25; 
                    const clickY = rect.y + (rect.height / 2);
                    
                    await page.mouse.click(clickX, clickY, { delay: 200 });
                    console.log("[AUTH] Clicked label-relative coordinates. Waiting 10s...");
                    await delay(10000);
                }
            }
        } catch (e) {
            console.log("[WARN] Aria search failed. Modal might be 'shielded'. Reverting to brute-force cluster...");
            // One last broad-area click attempt around the most likely modal center
            for (let x = 460; x <= 500; x += 20) {
                for (let y = 690; y <= 710; y += 10) {
                    await page.mouse.click(x, y);
                    await delay(200);
                }
            }
            await delay(10000);
        }

        console.log("[PROCESS] Checking Claim button status...");
        const claimResult = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const claimBtn = btns.find(b => b.innerText.includes('12,000'));
            if (claimBtn && !claimBtn.disabled) {
                claimBtn.click();
                return "CLICKED";
            }
            return claimBtn ? "STILL_DISABLED" : "NOT_FOUND";
        });

        console.log(`[PROCESS] Button Status: ${claimResult}`);
        if (claimResult === "CLICKED") {
            console.log("[SUCCESS] Credits claimed!");
            await delay(5000);
        }

        await page.screenshot({ path: `${shotPath}2_after_claim.png`, fullPage: true });

    } catch (e) { 
        console.error("[FATAL ERROR]", e.message); 
    } finally { 
        await browser.close(); 
        console.log("[EXIT] Done."); 
    }
}

run();