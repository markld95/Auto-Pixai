require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require('fs');
puppeteer.use(StealthPlugin());

const url = "https://pixai.art";
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
    if (!COOKIE_STRING) {
        console.error("[ERROR] No PIXAI_COOKIE found.");
        return;
    }
    
    const cookieArray = COOKIE_STRING.split(';').filter(c => c.trim().length > 0);
    
    for (const cookie of cookieArray) {
        const parts = cookie.trim().split('=');
        if (parts.length < 2) continue;
        
        const name = parts[0].trim();
        const value = parts.slice(1).join('=').trim();

        const cookieParams = {
            name: name,
            value: value,
            path: '/',
            secure: true,
            sameSite: 'Lax'
        };

        // Set for both potential domains to ensure the session 'sticks'
        await page.setCookie({ ...cookieParams, domain: '.pixai.art' });
        await page.setCookie({ ...cookieParams, domain: 'pixai.art' });
    }
    
    console.log(`[AUTH] Injected ${cookieArray.length} cookies into session.`);
}

async function run() {
    console.log("[INFO] Starting PixAI Auto-Claimer (Session-Fix Mode)...");

    const config = { 
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? [
            "--disable-gpu", "--disable-setuid-sandbox", "--no-sandbox", 
            "--no-zygote", "--disable-dev-shm-usage", `--lang=${LANG}`
        ] : []
    };

    const browser = await puppeteer.launch(config);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

    try {
        // Initial load to set the domain context
        console.log("[NAV] Initializing domain...");
        await page.goto(url, { waitUntil: "networkidle2" });
        
        // Apply cookies and reload to activate session
        await applyCookies(page);
        console.log("[NAV] Reloading with active session...");
        await page.reload({ waitUntil: "networkidle2" });
        
        // Extra 5s wait to let the UI update from "Sign in" to "Profile"
        await delay(5000);

        let claimed = false;
        const maxAttempts = 15; 

        for (let i = 0; i < maxAttempts; i++) {
            console.log(`[PROCESS] Scan attempt ${i + 1}/${maxAttempts}...`);
            
            const targetFound = await page.evaluate(() => {
                const keywords = ['claim', 'get', 'collect', 'check-in', 'receive'];
                const elements = Array.from(document.querySelectorAll('button, div[role="button"], span, a'));
                
                const btn = elements.find(el => {
                    const text = el.innerText.toLowerCase();
                    const isVisible = el.offsetWidth > 0 && el.offsetHeight > 0;
                    
                    const hasKeyword = keywords.some(k => text.includes(k));
                    const isNotInvite = !text.includes('invite') && !text.includes('rebate');
                    const hasNumbers = /\d/.test(text);

                    return hasKeyword && isVisible && isNotInvite && hasNumbers;
                });

                if (btn) {
                    btn.click();
                    return { success: true, text: btn.innerText.trim() };
                }
                return false;
            });

            if (targetFound && targetFound.success) {
                console.log(`[SUCCESS] Found and clicked: "${targetFound.text}"`);
                claimed = true;
                await delay(5000); // Wait for the "Claimed" animation to finish
                break;
            }

            await delay(2000); 
        }

        if (!claimed) {
            console.log("[CRITICAL] Claim button not found. Check if logged in in screenshot.");
        }

    } catch (error) {
        console.error("[FATAL ERROR]", error.message);
    } finally {
        if (isDocker) {
            await page.screenshot({ path: `${shotDir}/last_run_state.png`, fullPage: true });
            console.log("[DEBUG] Final screenshot saved to verify login state.");
        }
        await browser.close();
        console.log("[EXIT] Process completed.");
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});