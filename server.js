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
        version: '3.0.0',
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
        // Method 1: Try APKPure direct
        console.log('Trying APKPure...');
        let result = await tryApkPure(packageName);
        if (result.success) {
            return res.json(result);
        }
        
        // Method 2: Try ApkMirror
        console.log('Trying APKMirror...');
        result = await tryApkMirror(packageName);
        if (result.success) {
            return res.json(result);
        }
        
        // Method 3: Try APKMonk
        console.log('Trying APKMonk...');
        result = await tryApkMonk(packageName);
        if (result.success) {
            return res.json(result);
        }

        // Method 4: Return manual download pages
        console.log('All methods failed, returning manual links');
        res.json({
            success: false,
            error: 'Could not find direct APK link',
            manualDownload: {
                apkpure: `https://apkpure.com/search?q=${packageName}`,
                apkmirror: `https://www.apkmirror.com/?s=${packageName}`,
                apkmonk: `https://www.apkmonk.com/app/${packageName}/`
            },
            packageName: packageName
        });
        
    } catch (error) {
        console.error(`Error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// APKPure - Most reliable source
async function tryApkPure(packageName) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        };

        // Step 1: Search for the app
        const searchUrl = `https://apkpure.com/search?q=${packageName}`;
        console.log(`  Searching: ${searchUrl}`);
        
        const searchResp = await axios.get(searchUrl, { headers, timeout: 15000 });
        const $search = cheerio.load(searchResp.data);
        
        // Find the app link
        let appPath = null;
        $search('a').each((i, elem) => {
            const href = $search(elem).attr('href');
            if (href && href.includes(`/${packageName}`)) {
                appPath = href;
                return false;
            }
        });
        
        // Also try finding by class
        if (!appPath) {
            const firstResult = $search('.first-info').attr('href') || 
                               $search('.search-title a').first().attr('href') ||
                               $search('a[href*="' + packageName.split('.').pop() + '"]').first().attr('href');
            if (firstResult) appPath = firstResult;
        }

        if (!appPath) {
            console.log('  APKPure: App not found in search');
            return { success: false };
        }

        // Step 2: Go to app page
        const appUrl = appPath.startsWith('http') ? appPath : `https://apkpure.com${appPath}`;
        console.log(`  App page: ${appUrl}`);
        
        const appResp = await axios.get(appUrl, { headers, timeout: 15000 });
        const $app = cheerio.load(appResp.data);
        
        // Find download link - try multiple selectors
        let downloadPage = $app('a.download_apk_news').attr('href') ||
                          $app('a[href*="/download"]').first().attr('href') ||
                          $app('.download-start-btn').attr('href') ||
                          $app('a.da').attr('href');
        
        if (!downloadPage) {
            // Try to construct download URL
            downloadPage = `${appUrl}/download`;
        }

        const downloadUrl = downloadPage.startsWith('http') ? downloadPage : `https://apkpure.com${downloadPage}`;
        console.log(`  Download page: ${downloadUrl}`);

        // Step 3: Get the actual APK link from download page
        const dlResp = await axios.get(downloadUrl, { headers, timeout: 15000 });
        const $dl = cheerio.load(dlResp.data);
        
        // Look for direct APK link
        let apkLink = $dl('a#download_link').attr('href') ||
                      $dl('a[href*=".apk"]').first().attr('href') ||
                      $dl('a.download-start-btn').attr('href') ||
                      $dl('a[href*="APK/"]').attr('href');
        
        // Try to find in scripts
        if (!apkLink) {
            const scripts = $dl('script').text();
            const match = scripts.match(/https:\/\/[^"'\s]+\.apk[^"'\s]*/);
            if (match) apkLink = match[0];
        }

        if (apkLink) {
            const finalUrl = apkLink.startsWith('http') ? apkLink : `https://apkpure.com${apkLink}`;
            console.log(`  ✓ Found APK: ${finalUrl}`);
            return {
                success: true,
                source: 'apkpure',
                downloadUrl: finalUrl,
                packageName: packageName
            };
        }

        // If no direct link, return the download page
        console.log(`  Returning download page URL`);
        return {
            success: true,
            source: 'apkpure_page',
            downloadUrl: downloadUrl,
            packageName: packageName,
            note: 'Download page - may need one click'
        };

    } catch (error) {
        console.log(`  APKPure error: ${error.message}`);
        return { success: false };
    }
}

// APKMirror
async function tryApkMirror(packageName) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };

        // Search
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
        console.log(`  APKMirror app: ${appUrl}`);

        // Get app page to find latest version
        const appResp = await axios.get(appUrl, { headers, timeout: 15000 });
        const $app = cheerio.load(appResp.data);
        
        // Find latest version download link
        const versionLink = $app('div.listWidget a.downloadLink').first().attr('href') ||
                           $app('a[href*="/download/"]').first().attr('href');

        if (versionLink) {
            const downloadPageUrl = `https://www.apkmirror.com${versionLink}`;
            console.log(`  ✓ APKMirror download page: ${downloadPageUrl}`);
            return {
                success: true,
                source: 'apkmirror',
                downloadUrl: downloadPageUrl,
                packageName: packageName,
                note: 'APKMirror page - requires one click'
            };
        }

        return { success: false };

    } catch (error) {
        console.log(`  APKMirror error: ${error.message}`);
        return { success: false };
    }
}

// APKMonk - Sometimes has direct links
async function tryApkMonk(packageName) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };

        const appUrl = `https://www.apkmonk.com/app/${packageName}/`;
        console.log(`  Trying APKMonk: ${appUrl}`);
        
        const resp = await axios.get(appUrl, { headers, timeout: 15000 });
        const $ = cheerio.load(resp.data);
        
        // Find download link
        let downloadLink = $('a#download_link').attr('href') ||
                          $('a.download-btn').attr('href') ||
                          $('a[href*=".apk"]').first().attr('href');

        if (downloadLink) {
            const finalUrl = downloadLink.startsWith('http') ? downloadLink : `https://www.apkmonk.com${downloadLink}`;
            console.log(`  ✓ APKMonk found: ${finalUrl}`);
            return {
                success: true,
                source: 'apkmonk',
                downloadUrl: finalUrl,
                packageName: packageName
            };
        }

        return { success: false };

    } catch (error) {
        console.log(`  APKMonk error: ${error.message}`);
        return { success: false };
    }
}

// Proxy download - streams APK through our server
app.get('/download-apk/:packageName', async (req, res) => {
    const packageName = req.params.packageName;
    
    try {
        // First get the download URL
        const result = await tryApkPure(packageName);
        
        if (!result.success || !result.downloadUrl) {
            return res.status(404).json({ error: 'APK not found' });
        }

        // Check if it's a direct APK link
        if (result.downloadUrl.includes('.apk')) {
            console.log(`Proxying APK download: ${result.downloadUrl}`);
            
            // Stream the APK
            const response = await axios({
                method: 'GET',
                url: result.downloadUrl,
                responseType: 'stream',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 300000 // 5 min timeout for large files
            });

            res.setHeader('Content-Type', 'application/vnd.android.package-archive');
            res.setHeader('Content-Disposition', `attachment; filename="${packageName}.apk"`);
            
            response.data.pipe(res);
        } else {
            // Return the download page URL
            res.json({
                success: true,
                downloadUrl: result.downloadUrl,
                note: 'Not a direct APK link'
            });
        }

    } catch (error) {
        console.error(`Proxy download error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Kosher Store Backend v3.0 running on port ${PORT}`);
});
