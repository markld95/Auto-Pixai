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

// Hardcoded to the mount point mapped in Unraid
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
    console.log(`[INFO] Starting PixAI Auto-Claimer (Coordinate-Attack Mode)`);
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
        // 1. Initial Login
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
        const localCookies = await parseLocalCookies(COOKIE_STRING);
        await applyCookies(page, localCookies);
        console.log(`[AUTH] Injected ${localCookies.length} user cookies.`);

        // 2. Navigate and wait for popup
        console.log("[NAV] Navigating to Generator...");
        await page.goto(url, { waitUntil: "networkidle2" });
        await delay(12000); // Increased wait for popup stability

        // BEFORE SCREENSHOT
        await page.screenshot({ path: `${shotPath}1_before_claim.png`, fullPage: true });

        // 3. Handle Cloudflare via Coordinate Click
        console.log("[PROCESS] Hunting for Turnstile iframe...");
        const cfFrameElement = await page.$('iframe[src*="cloudflare"], iframe[src*="turnstile"]');

        if (cfFrameElement) {
            console.log("[AUTH] Turnstile iframe detected. Calculating click coordinates...");
            const rect = await cfFrameElement.boundingBox();
            if (rect) {
                // The checkbox is on the left side of the widget.
                // We click 35 pixels from the left and dead-center vertically.
                const clickX = rect.x + 35;
                const clickY = rect.y + (rect.height / 2);
                
                // Perform a human-like move and click
                await page.mouse.move(clickX, clickY);
                await page.mouse.down();
                await delay(150);
                await page.mouse.up();
                
                console.log(`[AUTH] Dispatched click to (${clickX}, ${clickY}). Waiting 8s for verification...`);
                await delay(8000); 
            }
        } else {
            console.log("[INFO] No Cloudflare iframe found. It may be auto-solved.");
        }

        // 4. Click the "Claim" Button
        console.log("[PROCESS] Scanning for enabled Claim button...");
        const claimResult = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            // Look for the specific text from your screenshot
            const claimBtn = btns.find(b => b.innerText.toLowerCase().includes('claim 12,000'));
            
            if (claimBtn) {
                if (!claimBtn.disabled) {
                    claimBtn.click();
                    return "CLICKED";
                }
                return "FOUND_BUT_DISABLED";
            }
            return "NOT_FOUND";
        });

        console.log(`[PROCESS] Button Status: ${claimResult}`);
        if (claimResult === "CLICKED") {
            await delay(4000);
            console.log("[SUCCESS] Credits should be claimed.");
        }

        // AFTER SCREENSHOT
        await page.screenshot({ path: `${shotPath}2_after_claim.png`, fullPage: true });

    } catch (e) { 
        console.error("[FATAL ERROR]", e.message); 
    } finally { 
        await browser.close(); 
        console.log("[EXIT] Done."); 
    }
}

run();