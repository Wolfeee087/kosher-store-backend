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
        version: '3.1.0',
        endpoints: [
            '/app/:packageName',
            '/search/:query',
            '/apk-url/:packageName',
            '/download-apk/:packageName'
        ]
    });
});

// Get app details from Play Store
app.get('/app/:packageName', async (req, res) => {
    try {
        const appData = await gplay.app({ appId: req.params.packageName });
        res.json({ success: true, app: appData });
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

// Main endpoint - Get APK download URL
app.get('/apk-url/:packageName', async (req, res) => {
    const packageName = req.params.packageName;
    console.log(`\n=== Fetching APK for: ${packageName} ===`);
    
    try {
        // Method 1: APKPure Direct URL (MOST RELIABLE!)
        // Pattern: https://d.apkpure.com/b/XAPK/{packageName}?version=latest
        console.log('Trying APKPure direct URL...');
        const apkPureDirectUrl = `https://d.apkpure.com/b/XAPK/${packageName}?version=latest`;
        
        // Verify the URL works
        try {
            const headResp = await axios.head(apkPureDirectUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 10000,
                maxRedirects: 5
            });
            
            // If we get here, URL is valid
            console.log(`  ✓ APKPure direct URL works!`);
            return res.json({
                success: true,
                source: 'apkpure_direct',
                downloadUrl: apkPureDirectUrl,
                packageName: packageName,
                format: 'XAPK',
                note: 'Direct download link - may be XAPK format (contains APK + OBB)'
            });
        } catch (headError) {
            console.log(`  APKPure direct URL failed: ${headError.message}`);
            
            // Try APK format instead of XAPK
            const apkPureApkUrl = `https://d.apkpure.com/b/APK/${packageName}?version=latest`;
            try {
                await axios.head(apkPureApkUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    timeout: 10000
                });
                console.log(`  ✓ APKPure APK format works!`);
                return res.json({
                    success: true,
                    source: 'apkpure_direct',
                    downloadUrl: apkPureApkUrl,
                    packageName: packageName,
                    format: 'APK'
                });
            } catch (e) {
                console.log(`  APK format also failed`);
            }
        }

        // Method 2: Try APKMirror search
        console.log('Trying APKMirror...');
        let result = await tryApkMirror(packageName);
        if (result.success) {
            return res.json(result);
        }

        // Method 3: APKCombo direct
        console.log('Trying APKCombo...');
        result = await tryApkCombo(packageName);
        if (result.success) {
            return res.json(result);
        }

        // Fallback: Return manual download pages
        console.log('All methods failed, returning manual links');
        res.json({
            success: false,
            error: 'Could not find direct APK link',
            manualDownload: {
                apkpure: `https://apkpure.com/search?q=${packageName}`,
                apkmirror: `https://www.apkmirror.com/?s=${packageName}`,
                apkcombo: `https://apkcombo.com/search/${packageName}`
            },
            packageName: packageName
        });
        
    } catch (error) {
        console.error(`Error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// APKMirror - Returns download page URL
async function tryApkMirror(packageName) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };

        // Search for the app
        const searchUrl = `https://www.apkmirror.com/?post_type=app_release&searchtype=app&s=${packageName}`;
        const searchResp = await axios.get(searchUrl, { headers, timeout: 15000 });
        const $search = cheerio.load(searchResp.data);
        
        // Find first app result
        const appLink = $search('div.appRow h5.appRowTitle a').first().attr('href');
        
        if (!appLink) {
            console.log('  APKMirror: App not found');
            return { success: false };
        }

        const appUrl = `https://www.apkmirror.com${appLink}`;
        console.log(`  ✓ APKMirror found: ${appUrl}`);
        
        return {
            success: true,
            source: 'apkmirror',
            downloadUrl: appUrl,
            packageName: packageName,
            note: 'APKMirror app page - user needs to select version and download'
        };

    } catch (error) {
        console.log(`  APKMirror error: ${error.message}`);
        return { success: false };
    }
}

// APKCombo - Alternative source
async function tryApkCombo(packageName) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };

        // Direct app page
        const appUrl = `https://apkcombo.com/app/${packageName}/`;
        console.log(`  Trying APKCombo: ${appUrl}`);
        
        const resp = await axios.get(appUrl, { headers, timeout: 15000 });
        
        if (resp.status === 200) {
            console.log(`  ✓ APKCombo page exists`);
            return {
                success: true,
                source: 'apkcombo',
                downloadUrl: appUrl,
                packageName: packageName,
                note: 'APKCombo page - click download button'
            };
        }

        return { success: false };

    } catch (error) {
        console.log(`  APKCombo error: ${error.message}`);
        return { success: false };
    }
}

// Proxy download - streams APK through our server (BYPASSES BROWSER SECURITY RISK)
app.get('/download-apk/:packageName', async (req, res) => {
    const packageName = req.params.packageName;
    
    try {
        // Use APKPure direct URL pattern
        const downloadUrl = `https://d.apkpure.com/b/XAPK/${packageName}?version=latest`;
        
        console.log(`Proxying APK download: ${downloadUrl}`);
        
        // Stream the file through our server
        const response = await axios({
            method: 'GET',
            url: downloadUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive'
            },
            timeout: 300000, // 5 min timeout for large files
            maxRedirects: 10
        });

        // Set headers for APK download
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', `attachment; filename="${packageName}.apk"`);
        
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }
        
        // Pipe the download to client
        response.data.pipe(res);
        
        response.data.on('error', (err) => {
            console.error(`Stream error: ${err.message}`);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Download stream failed' });
            }
        });

    } catch (error) {
        console.error(`Proxy download error: ${error.message}`);
        
        // Try APK format if XAPK failed
        try {
            const apkUrl = `https://d.apkpure.com/b/APK/${packageName}?version=latest`;
            console.log(`Trying APK format: ${apkUrl}`);
            
            const response = await axios({
                method: 'GET',
                url: apkUrl,
                responseType: 'stream',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 300000
            });

            res.setHeader('Content-Type', 'application/vnd.android.package-archive');
            res.setHeader('Content-Disposition', `attachment; filename="${packageName}.apk"`);
            response.data.pipe(res);
            
        } catch (apkError) {
            res.status(500).json({ 
                error: 'Could not download APK',
                details: error.message,
                manualDownload: `https://apkpure.com/search?q=${packageName}`
            });
        }
    }
});

// Search with APK URL included
app.get('/search-with-apk/:query', async (req, res) => {
    try {
        const results = await gplay.search({
            term: req.params.query,
            num: 10
        });
        
        const appsWithApk = results.map(app => ({
            name: app.title,
            packageName: app.appId,
            developer: app.developer,
            icon: app.icon,
            rating: app.score,
            installs: app.installs,
            free: app.free,
            // Include pre-built APK URLs
            apkUrls: {
                apkpure: `https://d.apkpure.com/b/XAPK/${app.appId}?version=latest`,
                apkpureApk: `https://d.apkpure.com/b/APK/${app.appId}?version=latest`,
                proxy: `https://kosher-store-backend.onrender.com/download-apk/${app.appId}`
            }
        }));
        
        res.json({ success: true, results: appsWithApk });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Kosher Store Backend v3.1 running on port ${PORT}`);
});
