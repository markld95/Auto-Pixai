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
    if (!COOKIE_STRING) {
        console.error("[ERROR] No PIXAI_COOKIE found.");
        return;
    }

    let decodedCookies = COOKIE_STRING;
    
    // Check if the string is Base64 (common in Docker env vars)
    if (!COOKIE_STRING.includes('\t') && !COOKIE_STRING.includes('=')) {
        console.log("[AUTH] Base64 detected, decoding...");
        decodedCookies = Buffer.from(COOKIE_STRING, 'base64').toString('utf-8');
    }

    const lines = decodedCookies.split('\n');
    let count = 0;

    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;

        const tabs = line.split('\t');
        if (tabs.length >= 7) {
            const [domain, flag, path, secure, expires, name, value] = tabs;
            await page.setCookie({
                name: name.trim(),
                value: value.trim(),
                domain: domain.startsWith('.') ? domain : `.${domain}`,
                path: path,
                secure: secure.toUpperCase() === 'TRUE',
                sameSite: 'Lax'
            });
            count++;
        } else if (line.includes('=')) {
            const pairs = line.split(';');
            for (const pair of pairs) {
                const [name, ...valParts] = pair.trim().split('=');
                if (!name || valParts.length === 0) continue;
                const value = valParts.join('=');
                const cookieParams = { name: name.trim(), value: value.trim(), path: '/', secure: true, sameSite: 'Lax' };
                await page.setCookie({ ...cookieParams, domain: '.pixai.art' });
                await page.setCookie({ ...cookieParams, domain: 'pixai.art' });
                count++;
            }
        }
    }
    console.log(`[AUTH] Successfully applied ${count} cookie parameters.`);
}

async function run() {
    console.log("[INFO] Starting PixAI Auto-Claimer (Base64-Fix Mode)...");

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
    await page.setViewport({ width: 1280, height: 1024 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    try {
        console.log("[NAV] Initializing...");
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
        
        await applyCookies(page);
        
        console.log("[NAV] Navigating to Generator with Session...");
        await page.goto(url, { waitUntil: "networkidle2" });
        
        // Wait longer for session to reflect in UI
        await delay(8000);

        let claimed = false;
        for (let i = 0; i < 15; i++) {
            console.log(`[PROCESS] Scan attempt ${i + 1}/15...`);
            
            const result = await page.evaluate(() => {
                const keywords = ['claim', 'get', 'collect', 'check-in', 'receive'];
                const elements = Array.from(document.querySelectorAll('button, div[role="button"], span, a'));
                
                const btn = elements.find(el => {
                    const text = el.innerText.toLowerCase();
                    const isVisible = el.offsetWidth > 0 && el.offsetHeight > 0;
                    return keywords.some(k => text.includes(k)) && isVisible && !text.includes('invite') && /\d/.test(text);
                });

                if (btn) {
                    btn.click();
                    return { success: true, text: btn.innerText.trim() };
                }
                return false;
            });

            if (result && result.success) {
                console.log(`[SUCCESS] Found and clicked: "${result.text}"`);
                claimed = true;
                await delay(5000); 
                break;
            }
            await delay(2000); 
        }

        if (!claimed) console.log("[CRITICAL] Claim button not found.");

    } catch (error) {
        console.error("[FATAL ERROR]", error.message);
    } finally {
        if (isDocker) {
            await page.screenshot({ path: `${shotDir}/last_run_state.png`, fullPage: true });
            console.log("[DEBUG] State saved to /screenshots/last_run_state.png");
        }
        await browser.close();
        console.log("[EXIT] Process completed.");
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});