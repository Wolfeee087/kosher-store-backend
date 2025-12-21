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
        version: '2.1.0',
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
        // Try APKCombo first (most reliable)
        let result = await getApkComboUrl(packageName);
        if (result.url) {
            console.log(`Found APKCombo URL: ${result.url}`);
            return res.json({ 
                success: true, 
                source: 'apkcombo',
                downloadUrl: result.url,
                version: result.version || '',
                packageName: packageName
            });
        }
        
        // Try direct APKPure download page
        result = await getApkPureDownloadPage(packageName);
        if (result.url) {
            console.log(`Found APKPure page: ${result.url}`);
            return res.json({ 
                success: true, 
                source: 'apkpure_page',
                downloadUrl: result.url,
                version: result.version || '',
                packageName: packageName
            });
        }

        // Return fallback URLs for manual download
        res.json({ 
            success: true,
            source: 'manual',
            downloadUrl: `https://apkcombo.com/downloader/#package=${packageName}`,
            fallbackUrls: {
                apkcombo: `https://apkcombo.com/downloader/#package=${packageName}`,
                apkpure: `https://apkpure.com/search?q=${packageName}`,
                evozi: `https://apps.evozi.com/apk-downloader/?id=${packageName}`
            },
            packageName: packageName,
            message: 'Use download page - direct link not available'
        });
        
    } catch (error) {
        console.error(`Error fetching APK: ${error.message}`);
        res.json({ 
            success: false, 
            error: error.message,
            fallbackUrls: {
                apkcombo: `https://apkcombo.com/downloader/#package=${packageName}`,
                apkpure: `https://apkpure.com/search?q=${packageName}`
            }
        });
    }
});

// APKCombo - Try to get download page URL
async function getApkComboUrl(packageName) {
    try {
        // APKCombo has a nice URL structure
        const downloadPageUrl = `https://apkcombo.com/downloader/#package=${packageName}`;
        
        // Try to find the app page first
        const searchUrl = `https://apkcombo.com/search/${packageName}`;
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            },
            timeout: 15000
        });
        
        const $ = cheerio.load(response.data);
        
        // Find app link
        let appUrl = null;
        $('a.content').each((i, elem) => {
            const href = $(elem).attr('href');
            if (href && href.includes(packageName.split('.').pop())) {
                appUrl = href;
                return false;
            }
        });

        // If we found the app page, construct download URL
        if (appUrl) {
            const fullUrl = appUrl.startsWith('http') ? appUrl : `https://apkcombo.com${appUrl}`;
            return { url: `${fullUrl}/download/apk`, version: '' };
        }
        
        // Return the downloader page as fallback
        return { url: downloadPageUrl, version: '' };
        
    } catch (error) {
        console.error(`APKCombo error: ${error.message}`);
        return { url: null };
    }
}

// APKPure - Get download page URL
async function getApkPureDownloadPage(packageName) {
    try {
        // Construct direct URL to app
        const appName = packageName.split('.').pop();
        const possibleUrls = [
            `https://apkpure.com/${appName}/${packageName}/download`,
            `https://apkpure.com/app/${packageName}/download`
        ];
        
        for (const url of possibleUrls) {
            try {
                const response = await axios.head(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: 5000,
                    maxRedirects: 5
                });
                
                if (response.status === 200) {
                    return { url: url, version: '' };
                }
            } catch (e) {
                // Try next URL
            }
        }
        
        // Return search page
        return { url: `https://apkpure.com/search?q=${packageName}`, version: '' };
        
    } catch (error) {
        console.error(`APKPure error: ${error.message}`);
        return { url: null };
    }
}

// Legacy endpoint - returns download page URLs
app.get('/download/:packageName', async (req, res) => {
    const packageName = req.params.packageName;
    
    try {
        // Get app info first
        const appInfo = await gplay.app({ appId: packageName }).catch(() => null);
        
        // Get best download URL
        let downloadResult = await getApkComboUrl(packageName);
        
        res.json({
            success: true,
            app: appInfo ? {
                name: appInfo.title,
                version: appInfo.version,
                size: appInfo.size,
                icon: appInfo.icon
            } : null,
            downloadUrl: downloadResult.url,
            downloadPages: {
                apkcombo: `https://apkcombo.com/downloader/#package=${packageName}`,
                apkpure: `https://apkpure.com/search?q=${packageName}`,
                evozi: `https://apps.evozi.com/apk-downloader/?id=${packageName}`
            }
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Search and get download URLs for results
app.get('/search-with-apk/:query', async (req, res) => {
    try {
        const results = await gplay.search({
            term: req.params.query,
            num: 5
        });
        
        const appsWithDownload = results.map(app => ({
            name: app.title,
            packageName: app.appId,
            developer: app.developer,
            icon: app.icon,
            rating: app.score,
            installs: app.installs,
            free: app.free,
            downloadUrl: `https://apkcombo.com/downloader/#package=${app.appId}`
        }));
        
        res.json({ success: true, results: appsWithDownload });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Kosher Store Backend v2.1 running on port ${PORT}`);
});
