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
        } catch (e) { }
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
        return { name: tabs[5], value: tabs[6], domain: tabs[0], path: tabs[2] };
    });
}

async function run() {
    console.log(`[INFO] Starting PixAI Auto-Claimer (Visual-Anchor Mode)`);
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
        const localCookies = await parseLocalCookies(COOKIE_STRING);
        await applyCookies(page, localCookies);

        console.log("[NAV] Moving to Generator...");
        await page.goto(url, { waitUntil: "networkidle2" });
        await delay(15000); 

        // Visual Evidence
        await page.screenshot({ path: `${shotPath}1_before_claim.png` });

        // --- NEW: Visual Anchor Search ---
        console.log("[PROCESS] Searching for the Cloudflare widget anchor...");
        const anchor = await page.evaluate(() => {
            // Find all iframes and look for the one containing Turnstile
            const frames = Array.from(document.querySelectorAll('iframe'));
            const cfFrame = frames.find(f => f.src.includes('cloudflare.com') || f.getAttribute('title')?.includes('widget'));
            
            if (cfFrame) {
                const rect = cfFrame.getBoundingClientRect();
                return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
            }
            return null;
        });

        if (anchor && anchor.w > 0) {
            console.log(`[AUTH] Anchor found at ${Math.round(anchor.x)}, ${Math.round(anchor.y)}. Target verified.`);
            // The actual checkbox is roughly at the start (left side) of this iframe
            const clickX = anchor.x + 30; 
            const clickY = anchor.y + (anchor.h / 2);
            
            await page.mouse.click(clickX, clickY);
            console.log(`[AUTH] Clicked center-left of anchor: ${Math.round(clickX)}, ${Math.round(clickY)}`);
        } else {
            console.log("[WARN] No anchor found. Falling back to wide-net sweep...");
            // If we can't "see" it via code, we sweep the area identified in your previous screenshots
            for (let x = 370; x <= 410; x += 10) {
                for (let y = 705; y <= 735; y += 10) {
                    await page.mouse.click(x, y);
                    await delay(300);
                }
            }
        }

        console.log("[WAIT] Verifying...");
        await delay(15000); 

        const claimResult = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const claimBtn = btns.find(b => b.innerText.includes('12,000') || b.innerText.includes('Claim'));
            if (claimBtn && !claimBtn.disabled) {
                claimBtn.click();
                return "SUCCESS";
            }
            return "STILL_DISABLED";
        });

        console.log(`[RESULT] Claim Status: ${claimResult}`);
        await page.screenshot({ path: `${shotPath}2_after_claim.png` });

    } catch (e) { 
        console.error("[FATAL ERROR]", e.message); 
    } finally { 
        await browser.close(); 
        console.log("[EXIT] Done."); 
    }
}

run();