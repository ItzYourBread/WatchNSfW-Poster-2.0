if (typeof global.Blob === 'undefined') {
    global.Blob = class Blob {
        constructor(fileBits, options) {
            this.size = fileBits.reduce((acc, bit) => acc + (typeof bit === 'string' ? Buffer.byteLength(bit, 'utf8') : bit.length), 0);
            this.type = options?.type || '';
        }
    };
}
if (typeof global.File === 'undefined') {
    global.File = class File extends global.Blob {
        constructor(fileBits, fileName, options) {
            super(fileBits, options);
            this.name = fileName;
            this.lastModified = options?.lastModified || Date.now();
        }
    };
}

const express = require('express');
const path = require('path');
const multer = require('multer');
const bodyParser = require('body-parser');
const Jimp = require('jimp');
const axios = require('axios');
const FormData = require('form-data');
const fetch = require('node-fetch');
const { Telegraf, Telegram } = require('telegraf');
const cheerio = require('cheerio');
const fs = require('fs-extra');

// ASSUMED EXTERNAL MODULES:
const jpApi = require("./jpAPI.js");
const { Replace } = require("stubby.ts");

// --- CONFIGURATION & SETUP ---
const app = express();
const port = process.env.PORT || 3000;
const botToken = '6793665291:AAHbyZ90SeMT_p4JJEXQYa6U2m7Qj41SPyA'; // Replace with your actual token
const bot = new Telegraf(botToken);
const telegram = new Telegram(botToken);

// Load the JSON data
const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));

// Set up EJS and Middleware
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const upload = multer({ dest: 'uploads/' });

async function deleteUploads() {
    try {
        await fs.emptyDir('uploads/');
        console.log('R.I.Y.A: Cleaned "uploads/" directory on startup.');
    } catch (error) {
        console.error('R.I.Y.A: Error deleting directories:', error.message);
    }
}
deleteUploads();

// --- CORE UTILITY FUNCTIONS ---

function btoa(str) {
    return Buffer.from(str.toString(), "binary").toString("base64");
}

function escapeMarkdownV2(text) {
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// Helper: Pick a random image from the backend folder structure
async function getRandomImage(channel, textLabeling) {
    // Path: random_images/CHANNEL/
    // *** MODIFICATION: Removed 'textLabeling' from the path. ***
    const dir = path.join('./random_images'); 
    
    // The placeholder path remains the same
    const placeholderPath = path.join('public', 'placeholder.png'); 

    try {
        if (!await fs.pathExists(dir)) {
            console.warn(`R.I.Y.A: Random image path not found for channel: ${dir}.`);
            return placeholderPath;
        }

        const files = await fs.readdir(dir);
        // Filter out any hidden files or subdirectories (though this assumes all files are directly here)
        const imageFiles = files.filter(f => !f.startsWith('.') && fs.statSync(path.join(dir, f)).isFile()); 

        if (imageFiles.length === 0) {
            console.error(`R.I.Y.A: Folder ${dir} is empty.`);
            return placeholderPath;
        }

        const randomFile = imageFiles[Math.floor(Math.random() * imageFiles.length)];
        return path.join(dir, randomFile);

    } catch (e) {
        console.error('R.I.Y.A: Error reading random image directory:', e.message);
        return placeholderPath;
    }
}

function parseBulkInput(bulkText, isScrapeMode, isManualData) {
    const lines = bulkText.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
    if (isScrapeMode) return lines.filter(line => line.startsWith('http'));

    const entries = [];
    for (let i = 0; i < lines.length; i += 2) {
        const lineA = lines[i];
        const lineB = lines[i + 1];
        if (!lineA) break;

        if (lineA.toUpperCase().startsWith('NAME:') && lineB?.toUpperCase().startsWith('LINK:')) {
            entries.push({ name: lineA.replace(/NAME\s*:\s*/i, '').trim(), link: lineB.replace(/LINK\s*:\s*/i, '').trim() });
        } else if (lineB?.startsWith('http') && !lineA.startsWith('http')) {
            entries.push({ name: lineA, link: lineB });
        } else if (lineA.startsWith('http')) {
            entries.push({ name: lineA, link: lineA });
        }
    }
    return entries;
}

async function scrapeRentry(rentryUrl) {
    try {
        const { data: html } = await axios.get(rentryUrl);
        const $ = cheerio.load(html);
        const entryText = $('.entry-text article div').first();
        let name = entryText.find('p').first().text().trim();
        let link = entryText.find('a.external').attr('href');
        return (name && link) ? { name, link } : null;
    } catch (error) {
        return null;
    }
}


// --- SHORTENING FUNCTIONS (Unchanged) ---

async function linkvertise(userid, link) {
    try {
        var base_url = `https://link-to.net/${userid}/${Math.random() * 1000}/dynamic`;
        var href = base_url + "?r=" + btoa(encodeURI(link));
        var finalLink = "https://justpaster.xyz/" + await jpApi.shortenUrl(href);
        return finalLink;
    } catch (e) {
        console.error("R.I.Y.A: Linkvertise (API) error:", e.message);
        return link;
    }
}

async function LinkvertiseShortner(url, option, select) {
    console.log(`\n--- [LV START] Processing: ${url.substring(0, 30)}... ---`);
    try {
        // Step 1: Final destination
        const linkvertiseUrl = await linkvertise(option.linkvertiseId, url);
        console.log(`[LV 1/2] Destination Shortened: ${linkvertiseUrl}`);

        if (select === "1of1") {
            console.log(`[LV 1of1] Returning Direct Link.`);
            return linkvertiseUrl;
        }

        // Step 2: JustPaster
        const replacements = { '%shortUrl%': linkvertiseUrl };
        const text = Replace(option.template, replacements);
        const pasteId = await jpApi.createPaste(text, true);
        const pasteUrl = `https://justpaster.xyz/${pasteId}`;
        console.log(`[LV 2/2] JustPaster ID: ${pasteId} | URL: ${pasteUrl}`);

        // Step 3: Shorten the Paste
        const finalLink = await linkvertise(option.linkvertiseId, pasteUrl);
        console.log(`[LV FINAL] Final Outer Link: ${finalLink}`);

        // Step 4: Anti-Bypass
        console.log(`[LV LOCK] Locking Paste ${pasteId} to Referrer: ${finalLink}`);
        await jpApi.addAntiBypass(pasteId, true, finalLink);

        return finalLink;
    } catch (error) {
        console.error('R.I.Y.A: Linkvertise Error:', error.message);
        return url;
    }
}

async function AdmavenShortner(url, option, select, attempts = 3) {
    console.log(`\n--- [AM START] Processing: ${url.substring(0, 30)}... (Attempt: ${4-attempts}) ---`);
    try {
        // Step 1
        const title1 = select === "1of1" ? "Final Link" : "Link 2 of 2";
        const apiUrl = `https://publishers.ad-maven.com/api/public/content_locker?api_token=${option.token}&title=${encodeURIComponent(title1)}&url=${encodeURIComponent(url)}`;

        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.type === 'fetched' && data.message?.[0]) {
            const innerShortUrl = option.domain + data.message[0].short;
            console.log(`[AM 1/2] Inner Ad Link: ${innerShortUrl}`);

            if (select === "1of1") return innerShortUrl;

            // Step 2: JustPaster
            const replacements = { '%shortUrl%': innerShortUrl };
            const text = Replace(option.template, replacements);
            const pasteId = await jpApi.createPaste(text, true);
            const pasteUrl = `https://justpaster.xyz/${pasteId}`;
            console.log(`[AM 2/2] JustPaster URL: ${pasteUrl}`);

            // Step 3: Outer Ad Link
            const title2 = "Link 1 of 2";
            const secondApiUrl = `https://publishers.ad-maven.com/api/public/content_locker?api_token=${option.token}&title=${encodeURIComponent(title2)}&url=${encodeURIComponent(pasteUrl)}`;
            
            const secondResponse = await fetch(secondApiUrl);
            const secondData = await secondResponse.json();

            if (secondData.type === 'fetched' && secondData.message?.[0]) {
                const outerShortUrl = option.domain + secondData.message[0].short;
                console.log(`[AM FINAL] Outer Ad Link: ${outerShortUrl}`);

                // Check for duplicate URLs which cause loops
                if (outerShortUrl === innerShortUrl) {
                    console.warn("⚠️ [AM WARNING] API returned identical links for both steps! This will loop.");
                } else {
                    console.log(`[AM LOCK] Locking Paste ${pasteId} to Referrer: ${outerShortUrl}`);
                    await jpApi.addAntiBypass(pasteId, true, outerShortUrl);
                }
                
                return outerShortUrl;
            }
        }
        throw new Error('AdMaven API returned empty/invalid response');
    } catch (error) {
        console.error(`R.I.Y.A: AdMaven Error:`, error.message);
        if (attempts > 0) return AdmavenShortner(url, option, select, attempts - 1);
        return url;
    }
}

// --- IMAGE PROCESSING & POSTING (Modified for Labeling) ---

// Checks if the file path is likely a raw multer upload path (no extension)
function isRawMulterPath(filePath) {
    const filename = path.basename(filePath);
    return !path.extname(filename);
}

async function processImage(imagePath, watermarkPath, textTemplate, textLabeling) {
    const normalizedPath = path.normalize(imagePath.replace(/"/g, ''));

    try {
        let image = await Jimp.read(normalizedPath);
        const outputFileName = `modified_${path.basename(normalizedPath)}.png`;
        const outputPath = path.join('uploads', outputFileName);

        image = image.cover(733, 1076);

        // Watermark
        const watermark = await Jimp.read(path.normalize(watermarkPath));
        watermark.resize(image.bitmap.width, Jimp.AUTO);
        image.composite(watermark, 0, 0, { mode: Jimp.BLEND_SOURCE_OVER, opacitySource: 0.3 });

        // Label Overlay (Only for non-manual channels)
        if (textLabeling) {
            const overlayTextPath = path.normalize(`images/${textTemplate}/${textLabeling}.png`);
            if (await fs.pathExists(overlayTextPath)) {
                const overlayText = await Jimp.read(overlayTextPath);
                overlayText.scale(1.5);
                const middleX = (image.bitmap.width - overlayText.bitmap.width) / 2;
                const middleY = (image.bitmap.height - overlayText.bitmap.height) / 2;
                image.composite(overlayText, middleX, middleY);
            }
        }

        await image.writeAsync(outputPath);
        return outputPath;
    } catch (error) {
        console.error('R.I.Y.A: Error processing image:', error.message);
        return normalizedPath; // Return original image path if processing fails
    }
}

async function sendToDiscord(webhookUrl, DiscordPremiumWebhook, title, PremiumLink, DiscordText, imagePath) {
    const normalizedImagePath = path.normalize(imagePath.replace(/"/g, ''));
    
    // Extract the base filename
    let fileName = path.basename(normalizedImagePath);
    
    // **NEW LOGIC:** If it's a raw Multer path (no extension), append .png for Discord
    if (isRawMulterPath(normalizedImagePath)) {
        fileName = `${fileName}.png`;
    }

    // --- Standard Webhook Form ---
    const form = new FormData();
    form.append('content', DiscordText);
    form.append('username', "R.I.Y.A");
    form.append('avatar_url', "https://i.ibb.co.com/2dzvc4R/2b1c18c5f5dc5ad00472383b1ee2504d.jpg");
    // Append the file stream, specifying the corrected filename
    form.append('file', fs.createReadStream(normalizedImagePath), fileName);

    // --- Premium Webhook Form ---
    const Premiumform = new FormData();
    Premiumform.append('content', `**${title}**\n**Link: ${PremiumLink} **`);
    Premiumform.append('username', "R.I.Y.A");
    Premiumform.append('avatar_url', "https://i.ibb.co.com/2dzvc4R/2b1c18c5f5dc5ad00472383b1ee2504d.jpg");
    // Append the file stream, specifying the corrected filename for the premium webhook
    Premiumform.append('file', fs.createReadStream(normalizedImagePath), fileName);

    try {
        await axios.post(webhookUrl, form, { headers: form.getHeaders() });
        if (DiscordPremiumWebhook) {
            await axios.post(DiscordPremiumWebhook, Premiumform, { headers: Premiumform.getHeaders() });
        }
    } catch (error) {
        console.error('R.I.Y.A: Error sending to Discord:', error.message);
    }
}

async function sendToTelegram(telegramTopic, TelegramText, imagePath, messageThreadId) {
    const normalizedImagePath = path.normalize(imagePath.replace(/"/g, ''));
    try {
        await telegram.sendPhoto(
            telegramTopic,
            { source: normalizedImagePath },
            { caption: TelegramText, parse_mode: "MarkdownV2", message_thread_id: messageThreadId }
        );
    } catch (error) {
        console.error('R.I.Y.A: Error sending to Telegram topic:', error.message);
    }
}

async function handleAdFreePosting(serverData, channel, title, rawLink, imagePath) {
    // 1. FIX: Added -100 prefix (Standard for Supergroups/Topics)
    const targetChatId = "-1002163065425"; 
    
    // 2. FIX: Use HTML instead of MarkdownV2 to prevent "parsing" crashes
    const adFreeText = `<b>${title}</b>\n\n🔓 <b>AD-FREE DIRECT LINK</b>\n<code>${rawLink}</code>`;

    try {
        if (serverData.name === "watchnsfw" && channel === "TeraBox") {
            console.log(`[AD-FREE] Routing TeraBox to Topic 581`);
            await telegram.sendPhoto(
                targetChatId,
                { source: path.normalize(imagePath) },
                { 
                    caption: adFreeText, 
                    parse_mode: "HTML", 
                    message_thread_id: 581 // Ensure this is an integer
                }
            );
        } 
        else if (channel !== "TeraBox") {
            console.log(`[AD-FREE] Routing ${channel} to Topic 582`);
            await telegram.sendPhoto(
                targetChatId,
                { source: path.normalize(imagePath) },
                { 
                    caption: adFreeText, 
                    parse_mode: "HTML", 
                    message_thread_id: 582 
                }
            );
        }
    } catch (error) {
        // This will now tell you EXACTLY why Telegram is rejecting it
        console.error('R.I.Y.A: Telegram Ad-Free Error:', error.description || error.message);
    }
}

// --- CORE ENTRY PROCESSOR ---
async function processSingleEntry(serverKey, channel, title, link, imagePath, selectType, adTypeArray, textLabeling) {
    const serverData = data[serverKey];

    if (!serverData || !serverData.Status) return;

    const cleanTitle = title.trim();    let finalLink = link;
    let DiscordText = `**${cleanTitle}**\n\n**⚝──⭒─𝓜𝓮𝓰𝓪⭑𝓕𝓸𝓵𝓭𝓮𝓻─⭒──⚝**\n`;
    let TelegramText = `*${escapeMarkdownV2(cleanTitle)}*\n\n*⚝──⭒─𝓜𝓮𝓰𝓪⭑𝓕𝓸𝓵𝓭𝓮𝓻─⭒──⚝*\n`;

    let effectiveAdType = serverData.name === "nsfw-nude" ? ["admaven", "linkvertise"] : adTypeArray;

    if (effectiveAdType && effectiveAdType.includes("admaven")) {
        const AmLink = await AdmavenShortner(finalLink, serverData, selectType);
        DiscordText += `\n***Option (AM):*** **${AmLink}**`;
        TelegramText += `\n***_Option \\(AM\\):_*** *${escapeMarkdownV2(AmLink)}*`;
    }

    if (effectiveAdType && effectiveAdType.includes("linkvertise")) {
        const LvLink = await LinkvertiseShortner(finalLink, serverData, selectType);
        DiscordText += `\n***Option (LV):*** **${LvLink}**`;
        TelegramText += `\n***_Option \\(LV\\):_*** *${escapeMarkdownV2(LvLink)}*`;
    }

    DiscordText += "\n\n**⚝─────⭒────⭑────⭒─────⚝**";
    TelegramText += "\n\n*⚝────⭒────⭑────⭒────⚝*";

    let outputImage;
    
    // **NEW LOGIC: Bypass image processing for 'Collection' channel**
    if (channel === 'Collection') {
        outputImage = imagePath; // Use the raw uploaded image path
    } else {
        const watermarkPath = path.join('images', serverData.name, 'watermark.png');
        outputImage = await processImage(imagePath, watermarkPath, serverData.name, textLabeling);
    }
    // **END NEW LOGIC**

    await handleAdFreePosting(serverData, channel, cleanTitle, link, outputImage);
    const webhookUrl = serverData.DiscordChannels && serverData.DiscordChannels[channel];

    if (webhookUrl) {
        await sendToDiscord(webhookUrl, serverData.DiscordPremiumWebhook, cleanTitle, finalLink, DiscordText, outputImage);

        if (serverData.name === "watchnsfw") {
            // Second Discord Post (as requested)
            await sendToDiscord("https://discord.com/api/webhooks/1448627617174650973/DOTQfRm5XZLNQ89xhau1iiQOOiDI1DL6k7dTgX5sM9CRV3sen5IIAEORp6gBUTst-bqO", 'https://discord.com/api/webhooks/1276224630616621077/h4qzudRkvMP8EuyNgmOE9WYj3QXxmtGdLFjuvBr3JTd-E4qKZvLb9aarA7WzMOlepcGi', cleanTitle, finalLink, DiscordText, outputImage);
        }
    }

    if (serverData.Telegram && serverData.TelegramTopics && serverData.TelegramTopics[channel]) {
        await sendToTelegram(serverData.Group, TelegramText, outputImage, serverData.TelegramTopics[channel]);
    }
}

// --- ROUTES ---

app.get('/', (req, res) => {
    res.render('index', { servers: Object.keys(data) });
});

// ... (All code before /process-bulk remains the same)

// Bulk Posting Route (Handles ALL channel logic)
app.post('/process-bulk', upload.single('image'), async (req, res) => {
    const { server, channel, bulkText, selectType, AdType, textLabeling } = req.body;
    
    // Channels requiring user upload (OF-Models, TeraBox, Collection)
    const isManualPhoto = (channel === 'OF-Models' || channel === 'TeraBox' || channel === 'Collection');
    
    // Check for image upload only if required by the channel
    if (isManualPhoto && !req.file) return res.status(400).send('Error: No image file uploaded for this channel.');
    
    res.render('success');

    try {
        const isScrape = (channel === 'OF-Models');
        const isTera = (channel === 'TeraBox');
        const isCollection = (channel === 'Collection'); // New variable for clarity
        
        // Parse the input based on the mode
        const entries = parseBulkInput(bulkText, isScrape, isTera || isCollection); // Pass Tera/Collection to parser
        const servers = (server === 'All' ? Object.keys(data) : [server]);
        const adTypes = Array.isArray(AdType) ? AdType : [AdType].filter(Boolean);

        for (const sKey of servers) {
            for (const entry of entries) {
                let finalTitle, finalLink, finalImg;
                let postLabel = null; // Label only used for random image channels

                // 1. 📸 Image Sourcing
                if (isManualPhoto) {
                    finalImg = req.file.path; 
                } else {
                    finalImg = await getRandomImage(channel, textLabeling); 
                    postLabel = textLabeling; // Apply label overlay/text
                }

                // 2. 📝 Data Sourcing
                if (isScrape) {
                    // OF-Models: Rentry scraping
                    const scraped = await scrapeRentry(entry);
                    if (!scraped) continue;
                    finalTitle = scraped.name;
                    finalLink = scraped.link;
                } else if (isTera) {
                    // TeraBox: Manual name/link pair
                    finalTitle = "𝐎𝐩𝐞𝐧 𝐋𝐢𝐧𝐤𝐬 & 𝐖𝐚𝐭𝐜𝐡 𝐎𝐧𝐥𝐢𝐧𝐞 𝐄𝐚𝐬𝐢𝐥𝐲 + 𝐃𝐨𝐰𝐧𝐥𝐨𝐚𝐝"; 
                    finalLink = entry.link;
                } else if (isCollection) { // **<-- NEW LOGIC FOR COLLECTION**
                    // Collection: Manual name/link pair from input
                    finalTitle = entry.name ? entry.name : "New Collection Post"; 
                    finalLink = entry.link;
                } else {
                    // Other Channels (State-Snap, Amateur, Leaks-Vids): Label is title, link is the URL from input
                    finalTitle = textLabeling.replace(/-/g, ' ');
                    finalLink = entry.link;
                }

                // 3. 🚀 Process Entry
                await processSingleEntry(sKey, channel, finalTitle, finalLink, finalImg, selectType, adTypes, postLabel);
                
                // Delay between posts
                await new Promise(r => setTimeout(r, 1500));
            }
        }
        console.log("R.I.Y.A: Bulk processing complete.");
    } catch (e) { 
        console.error('R.I.Y.A: Error during bulk processing:', e.message); 
    }
});

// Start the server
app.listen(port, () => {
    console.log(`R.I.Y.A 2.0 Server running at http://localhost:${port}`);
});