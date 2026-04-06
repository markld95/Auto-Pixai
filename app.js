require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const url = "https://pixai.art";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
const isDocker = process.env.IS_DOCKER !== 'false';
const LANG = process.env.APP_LANG || "en-GB";

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
    console.log("[INFO] Starting PixAI Auto-Claimer...");

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
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

    try {
        console.log("[NAV] Navigating to PixAI...");
        await page.goto(url, { waitUntil: "networkidle2" });
        
        await applyCookies(page);
        await page.reload({ waitUntil: "networkidle2" });
        console.log("[AUTH] Session active. Waiting for daily popup...");

        // Wait 8 seconds for the popup to trigger and animate
        await delay(8000);

        const result = await page.evaluate(() => {
            const keywords = ['claim', 'get', 'collect', 'check-in', 'receive'];
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
            
            // Find a visible button containing one of our keywords
            const target = buttons.find(btn => {
                const text = btn.innerText.toLowerCase();
                const isVisible = btn.offsetWidth > 0 && btn.offsetHeight > 0;
                return keywords.some(k => text.includes(k)) && isVisible;
            });

            if (target) {
                target.click();
                return { success: true, text: target.innerText.trim() };
            }
            return { success: false };
        });

        if (result.success) {
            console.log(`[SUCCESS] Found and clicked: "${result.text}"`);
            await delay(2000); 
        } else {
            console.log("[CRITICAL] No claim button appeared. Already claimed or popup blocked.");
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