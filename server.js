const express = require('express');
const cors = require('cors');
const gplay = require('google-play-scraper');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'Kosher Store Backend Running',
        version: '2.0.0',
        endpoints: [
            '/app/:packageName',
            '/search/:query',
            '/download/:packageName',
            '/apk-url/:packageName'
        ]
    });
});

// Get app details from Play Store
app.get('/app/:packageName', async (req, res) => {
    try {
        const app = await gplay.app({ appId: req.params.packageName });
        res.json({ success: true, app });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Search Play Store
app.get('/search/:query', async (req, res) => {
    try {
        const results = await gplay.search({
            term: req.params.query,
            num: 10
        });
        
        const simplified = results.map(app => ({
            name: app.title,
            packageName: app.appId,
            developer: app.developer,
            icon: app.icon,
            rating: app.score,
            installs: app.installs,
            free: app.free
        }));
        
        res.json({ success: true, results: simplified });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Get direct APK download URL - tries multiple sources
app.get('/apk-url/:packageName', async (req, res) => {
    const packageName = req.params.packageName;
    console.log(`Fetching APK URL for: ${packageName}`);
    
    try {
        // Try APKPure first
        let apkUrl = await getApkPureDirectUrl(packageName);
        if (apkUrl) {
            console.log(`Found APKPure URL: ${apkUrl}`);
            return res.json({ 
                success: true, 
                source: 'apkpure',
                downloadUrl: apkUrl,
                packageName: packageName
            });
        }
        
        // Try APKMirror
        apkUrl = await getApkMirrorUrl(packageName);
        if (apkUrl) {
            console.log(`Found APKMirror URL: ${apkUrl}`);
            return res.json({ 
                success: true, 
                source: 'apkmirror',
                downloadUrl: apkUrl,
                packageName: packageName
            });
        }
        
        // Try Evozi APK Downloader as fallback
        const evoziUrl = `https://apps.evozi.com/apk-downloader/?id=${packageName}`;
        
        res.json({ 
            success: false, 
            error: 'Could not find direct APK URL',
            fallbackUrl: evoziUrl,
            message: 'Use the fallback URL to manually download'
        });
        
    } catch (error) {
        console.error(`Error fetching APK: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Get APKPure direct download URL
async function getApkPureDirectUrl(packageName) {
    try {
        // First get the app page
        const appPageUrl = `https://apkpure.com/search?q=${packageName}`;
        const searchResponse = await axios.get(appPageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 10000
        });
        
        const $ = cheerio.load(searchResponse.data);
        
        // Find the app link that matches our package name
        let appPath = null;
        $('a.first-info').each((i, elem) => {
            const href = $(elem).attr('href');
            if (href && href.includes(packageName)) {
                appPath = href;
                return false; // break
            }
        });
        
        // Alternative: check dd.search-title a
        if (!appPath) {
            $('dd.search-title a').each((i, elem) => {
                const href = $(elem).attr('href');
                if (href) {
                    appPath = href;
                    return false;
                }
            });
        }
        
        if (!appPath) {
            console.log('APKPure: App page not found');
            return null;
        }
        
        // Now get the download page
        const fullAppUrl = appPath.startsWith('http') ? appPath : `https://apkpure.com${appPath}`;
        console.log(`APKPure app URL: ${fullAppUrl}`);
        
        const appResponse = await axios.get(`${fullAppUrl}/download`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 10000
        });
        
        const $app = cheerio.load(appResponse.data);
        
        // Look for download link
        let downloadUrl = $app('a#download_link').attr('href');
        
        if (!downloadUrl) {
            downloadUrl = $app('a.download-start-btn').attr('href');
        }
        
        if (!downloadUrl) {
            // Try to find any APK download link
            $app('a').each((i, elem) => {
                const href = $app(elem).attr('href');
                if (href && href.includes('.apk')) {
                    downloadUrl = href;
                    return false;
                }
            });
        }
        
        return downloadUrl || null;
        
    } catch (error) {
        console.error(`APKPure error: ${error.message}`);
        return null;
    }
}

// Get APKMirror URL (returns page URL, not direct download due to their protection)
async function getApkMirrorUrl(packageName) {
    try {
        const searchUrl = `https://www.apkmirror.com/?post_type=app_release&searchtype=apk&s=${packageName}`;
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 10000
        });
        
        const $ = cheerio.load(response.data);
        
        // Find first result
        const firstResult = $('div.appRow a.fontBlack').first().attr('href');
        
        if (firstResult) {
            return `https://www.apkmirror.com${firstResult}`;
        }
        
        return null;
    } catch (error) {
        console.error(`APKMirror error: ${error.message}`);
        return null;
    }
}

// Legacy endpoint - returns multiple download options
app.get('/download/:packageName', async (req, res) => {
    const packageName = req.params.packageName;
    
    try {
        // Get app info first
        const appInfo = await gplay.app({ appId: packageName }).catch(() => null);
        
        // Try to get direct APK URL
        let directUrl = await getApkPureDirectUrl(packageName);
        
        res.json({
            success: true,
            app: appInfo ? {
                name: appInfo.title,
                version: appInfo.version,
                size: appInfo.size
            } : null,
            directApkUrl: directUrl,
            downloadUrls: {
                apkpure: `https://apkpure.com/search?q=${packageName}`,
                apkmirror: `https://www.apkmirror.com/?s=${packageName}`,
                evozi: `https://apps.evozi.com/apk-downloader/?id=${packageName}`
            }
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Search and return apps with APK availability info
app.get('/search-with-apk/:query', async (req, res) => {
    try {
        const results = await gplay.search({
            term: req.params.query,
            num: 5
        });
        
        // For each result, check if we can get an APK URL
        const appsWithApk = await Promise.all(results.map(async (app) => {
            const apkUrl = await getApkPureDirectUrl(app.appId).catch(() => null);
            return {
                name: app.title,
                packageName: app.appId,
                developer: app.developer,
                icon: app.icon,
                rating: app.score,
                installs: app.installs,
                free: app.free,
                apkAvailable: !!apkUrl,
                apkUrl: apkUrl
            };
        }));
        
        res.json({ success: true, results: appsWithApk });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Kosher Store Backend running on port ${PORT}`);
});
