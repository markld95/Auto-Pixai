require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require('fs');
puppeteer.use(StealthPlugin());

const url = "https://pixai.art";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
const isDocker = process.env.IS_DOCKER !== 'false';
const LANG = process.env.APP_LANG || "en-GB";

// Ensure screenshot directory exists in Docker
if (isDocker && !fs.existsSync('/screenshots')) {
    fs.mkdirSync('/screenshots', { recursive: true });
}

function delay(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
}

async function applyCookies(page) {
    if (!COOKIE_STRING) {
        console.error("[ERROR] No PIXAI_COOKIE found.");
        return;
    }
    const cookies = COOKIE_STRING.split(";").map(c => {
        const [name, ...rest] = c.trim().split("=");
        return {
            name,
            value: rest.join("="),
            domain: ".pixai.art",
            path: "/"
        };
    });
    await page.setCookie(...cookies);
    console.log("[AUTH] Cookies applied to session.");
}

async function run() {
    console.log("[INFO] Starting PixAI Auto-Claimer (Resilient Mode)...");

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
    
    // Set a realistic Window size to help popups render correctly
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

    try {
        console.log("[NAV] Navigating to PixAI...");
        await page.goto(url, { waitUntil: "networkidle2" });
        
        await applyCookies(page);
        await page.reload({ waitUntil: "networkidle2" });
        console.log("[AUTH] Session active. Waiting for popup to clear Cloudflare...");

        let claimed = false;
        const maxAttempts = 15; // 15 attempts * 2 seconds = 30 seconds total wait

        for (let i = 0; i < maxAttempts; i++) {
            console.log(`[PROCESS] Scan attempt ${i + 1}/${maxAttempts}...`);
            
            claimed = await page.evaluate(() => {
                const keywords = ['claim', 'get', 'collect', 'check-in', 'receive'];
                // Search for buttons or any clickable div containing keywords
                const elements = Array.from(document.querySelectorAll('button, div[role="button"], span'));
                
                const target = elements.find(el => {
                    const text = el.innerText.toLowerCase();
                    const isVisible = el.offsetWidth > 0 && el.offsetHeight > 0;
                    // Ensure the text contains a keyword and actually looks like a button
                    return keywords.some(k => text.includes(k)) && isVisible;
                });

                if (target) {
                    target.click();
                    return true;
                }
                return false;
            });

            if (claimed) {
                console.log("[SUCCESS] Claim button found and clicked!");
                await delay(3000); // Wait for the click to process
                break;
            }

            await delay(2000); // Wait 2 seconds before next scan
        }

        if (!claimed) {
            console.log("[CRITICAL] Claim button not found after 30s. Saving debug screenshot...");
            if (isDocker) {
                await page.screenshot({ path: '/screenshots/failure.png', fullPage: true });
                console.log("[DEBUG] Screenshot saved to /screenshots/failure.png");
            }
        }

    } catch (error) {
        console.error("[FATAL ERROR]", error.message);
    } finally {
        await browser.close();
        console.log("[EXIT] Process completed.");
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});