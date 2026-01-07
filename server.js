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
        version: '4.4.0',
        features: [
            'Device-aware APK filtering',
            'minSdk compatibility checks',
            'Automatic older version fallback with ?needsOlderVersion=true',
            'APKPure versions page scraping for older versions'
        ],
        endpoints: [
            '/app/:packageName',
            '/search/:query',
            '/apk-url/:packageName?apiLevel=30&arch=arm64-v8a',
            '/apk-url/:packageName?apiLevel=30&needsOlderVersion=true',
            '/check-compatibility/:packageName?apiLevel=30'
        ]
    });
});

// ============================================================
// DEVICE COMPATIBILITY HELPERS
// ============================================================

function getDeviceInfo(req) {
    return {
        apiLevel: parseInt(req.query.apiLevel) || null,
        arch: req.query.arch || null,
        dpi: req.query.dpi || null,
        androidVersion: req.query.androidVersion || null,
        needsOlderVersion: req.query.needsOlderVersion === 'true'
    };
}

function getAndroidVersionName(apiLevel) {
    const versions = {
        21: '5.0', 22: '5.1', 23: '6.0', 24: '7.0', 25: '7.1',
        26: '8.0', 27: '8.1', 28: '9', 29: '10', 30: '11',
        31: '12', 32: '12L', 33: '13', 34: '14', 35: '15'
    };
    return versions[apiLevel] || apiLevel?.toString() || 'Unknown';
}

function androidVersionToApi(versionStr) {
    if (!versionStr) return null;
    
    const mapping = {
        '4.4': 19, '5.0': 21, '5.1': 22, '6.0': 23, '7.0': 24, '7.1': 25,
        '8.0': 26, '8.1': 27, '9': 28, '9.0': 28, '10': 29, '10.0': 29, 
        '11': 30, '11.0': 30, '12': 31, '12L': 32, '13': 33, '14': 34, '15': 35
    };
    
    if (mapping[versionStr]) return mapping[versionStr];
    
    // Try to parse as number
    const num = parseFloat(versionStr);
    if (isNaN(num)) return null;
    
    if (num >= 15) return 35;
    if (num >= 14) return 34;
    if (num >= 13) return 33;
    if (num >= 12) return 31;
    if (num >= 11) return 30;
    if (num >= 10) return 29;
    if (num >= 9) return 28;
    if (num >= 8) return 26;
    if (num >= 7) return 24;
    if (num >= 6) return 23;
    if (num >= 5) return 21;
    
    return null;
}

// ============================================================
// APP DETAILS ENDPOINT
// ============================================================

app.get('/app/:packageName', async (req, res) => {
    try {
        const appData = await gplay.app({ appId: req.params.packageName });
        res.json({ success: true, app: appData });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// SEARCH ENDPOINT
// ============================================================

app.get('/search/:query', async (req, res) => {
    const deviceInfo = getDeviceInfo(req);
    
    try {
        const results = await gplay.search({ term: req.params.query, num: 20 });
        
        const simplified = results.map(app => ({
            name: app.title,
            packageName: app.appId || null,
            developer: app.developer,
            icon: app.icon,
            rating: app.score,
            installs: app.installs,
            free: app.free,
            androidVersion: app.androidVersion || null
        }));
        
        res.json({ 
            success: true, 
            results: simplified,
            deviceInfo: deviceInfo.apiLevel ? {
                apiLevel: deviceInfo.apiLevel,
                androidVersion: getAndroidVersionName(deviceInfo.apiLevel)
            } : undefined
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// MAIN APK URL ENDPOINT
// ============================================================

app.get('/apk-url/:packageName', async (req, res) => {
    const packageName = req.params.packageName;
    const deviceInfo = getDeviceInfo(req);
    
    console.log(`\n=== Fetching APK for: ${packageName} ===`);
    if (deviceInfo.apiLevel) {
        console.log(`Device: API ${deviceInfo.apiLevel} (Android ${getAndroidVersionName(deviceInfo.apiLevel)}), Arch: ${deviceInfo.arch || 'any'}`);
    }
    if (deviceInfo.needsOlderVersion) {
        console.log(`⚠️ Client requested OLDER VERSION (install of latest failed)`);
    }
    
    try {
        // Get app info from Play Store
        let appName = packageName;
        let minSdkFromStore = null;
        
        try {
            const appInfo = await gplay.app({ appId: packageName });
            appName = appInfo.title || packageName;
            if (appInfo.androidVersion && !appInfo.androidVersion.includes('Varies')) {
                minSdkFromStore = androidVersionToApi(appInfo.androidVersion);
                console.log(`Play Store: ${appName} requires Android ${appInfo.androidVersion} (API ${minSdkFromStore})`);
            }
        } catch (e) {
            console.log('Could not fetch Play Store info');
        }

        // Determine if we need to find an older version
        const mustFindOlderVersion = deviceInfo.needsOlderVersion || 
            (minSdkFromStore && deviceInfo.apiLevel && minSdkFromStore > deviceInfo.apiLevel);
        
        // ============================================================
        // OLDER VERSION PATH
        // ============================================================
        if (mustFindOlderVersion) {
            console.log('Searching for older compatible version...');
            
            // Try to scrape APKPure versions page for older versions
            const olderVersionResult = await findOlderVersionFromApkPure(packageName, deviceInfo, appName);
            
            if (olderVersionResult.success) {
                return res.json(olderVersionResult);
            }
            
            // If APKPure scraping failed, return error with helpful message
            console.log('✗ No compatible older version found');
            return res.json({
                success: false,
                compatible: false,
                error: `${appName} requires a newer Android version. Could not find an older compatible version automatically.`,
                packageName: packageName,
                appName: appName,
                deviceApiLevel: deviceInfo.apiLevel,
                requiredApiLevel: minSdkFromStore || 32,
                manualDownload: {
                    apkpure: `https://apkpure.com/search?q=${encodeURIComponent(appName)}`
                }
            });
        }

        // ============================================================
        // LATEST VERSION PATH (for compatible devices)
        // ============================================================
        console.log('Trying latest version...');
        
        // Try APKPure XAPK
        const xapkUrl = `https://d.apkpure.com/b/XAPK/${packageName}?version=latest`;
        try {
            const headResp = await axios.head(xapkUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 10000,
                maxRedirects: 5
            });
            console.log('✓ APKPure XAPK available');
            return res.json({
                success: true,
                source: 'apkpure',
                downloadUrl: xapkUrl,
                packageName: packageName,
                format: 'XAPK',
                version: 'latest',
                canRetryWithOlderVersion: true
            });
        } catch (e) {
            // Try APK format
            const apkUrl = `https://d.apkpure.com/b/APK/${packageName}?version=latest`;
            try {
                await axios.head(apkUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    timeout: 10000
                });
                console.log('✓ APKPure APK available');
                return res.json({
                    success: true,
                    source: 'apkpure',
                    downloadUrl: apkUrl,
                    packageName: packageName,
                    format: 'APK',
                    version: 'latest',
                    canRetryWithOlderVersion: true
                });
            } catch (e2) {
                console.log('APKPure not available');
            }
        }

        // Try APKMirror as fallback
        console.log('Trying APKMirror...');
        const apkmirrorResult = await tryApkMirror(packageName);
        if (apkmirrorResult.success) {
            return res.json({
                ...apkmirrorResult,
                canRetryWithOlderVersion: true
            });
        }

        // Fallback
        res.json({
            success: false,
            error: 'Could not find APK download',
            manualDownload: {
                apkpure: `https://apkpure.com/search?q=${packageName}`,
                apkmirror: `https://www.apkmirror.com/?s=${packageName}`
            },
            packageName: packageName
        });
        
    } catch (error) {
        console.error(`Error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// FIND OLDER VERSION FROM APKPURE
// Scrapes the versions page and finds a compatible older version
// ============================================================

async function findOlderVersionFromApkPure(packageName, deviceInfo, appName) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
    };

    try {
        // First, search for the app to get its APKPure URL
        console.log('  Searching APKPure for app page...');
        const searchUrl = `https://apkpure.com/search?q=${encodeURIComponent(packageName)}`;
        
        const searchResp = await axios.get(searchUrl, { 
            headers, 
            timeout: 15000,
            validateStatus: (status) => status < 500
        });
        
        if (searchResp.status === 403) {
            console.log('  APKPure blocked request (403)');
            return { success: false };
        }
        
        const $search = cheerio.load(searchResp.data);
        
        // Find the app link that matches our package name
        let appPageUrl = null;
        $search('a').each((i, el) => {
            const href = $search(el).attr('href') || '';
            if (href.includes(packageName) && href.includes('apkpure.com')) {
                appPageUrl = href;
                return false;
            }
        });
        
        // Also try common pattern
        if (!appPageUrl) {
            // Try to find any app link
            const firstAppLink = $search('.first-info a, .search-res a, a[href*="/search"]').first().attr('href');
            if (firstAppLink && !firstAppLink.includes('/search')) {
                appPageUrl = firstAppLink.startsWith('http') ? firstAppLink : `https://apkpure.com${firstAppLink}`;
            }
        }
        
        if (!appPageUrl) {
            // Construct URL directly
            appPageUrl = `https://apkpure.com/${appName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${packageName}`;
        }
        
        console.log(`  App page: ${appPageUrl}`);
        
        // Get versions page
        const versionsUrl = appPageUrl.replace(/\/$/, '') + '/versions';
        console.log(`  Checking versions page: ${versionsUrl}`);
        
        const versionsResp = await axios.get(versionsUrl, { 
            headers, 
            timeout: 15000,
            validateStatus: (status) => status < 500
        });
        
        if (versionsResp.status !== 200) {
            console.log(`  Versions page returned ${versionsResp.status}`);
            return { success: false };
        }
        
        const $versions = cheerio.load(versionsResp.data);
        
        // Parse version entries
        const versions = [];
        
        // APKPure version list - try multiple selectors
        $versions('.ver-item, .version-item, .ver, li[data-dt-version], .apk-info').each((i, el) => {
            const $el = $versions(el);
            const text = $el.text();
            
            // Extract Android requirement
            const androidMatch = text.match(/(?:Android|Requires)[:\s]*(\d+\.?\d*)/i);
            const versionMatch = text.match(/(\d+\.\d+(?:\.\d+)*)/);
            
            // Find download link
            let downloadLink = $el.find('a[href*="download"], a.download-btn, a.da').attr('href');
            if (!downloadLink) {
                downloadLink = $el.find('a').first().attr('href');
            }
            
            if (downloadLink && versionMatch) {
                const minAndroid = androidMatch ? androidMatch[1] : null;
                const minSdk = minAndroid ? androidVersionToApi(minAndroid) : null;
                
                versions.push({
                    version: versionMatch[1],
                    minSdk: minSdk,
                    minAndroid: minAndroid,
                    downloadLink: downloadLink.startsWith('http') ? downloadLink : `https://apkpure.com${downloadLink}`,
                    text: text.substring(0, 100).replace(/\s+/g, ' ').trim()
                });
            }
        });
        
        // Also try to find direct download links in scripts or data attributes
        const pageText = versionsResp.data;
        const directLinkMatch = pageText.match(/https:\/\/d\.apkpure\.com\/b\/(?:APK|XAPK)\/[^"'\s]+/g);
        if (directLinkMatch && directLinkMatch.length > 1) {
            // Found multiple direct links, the later ones might be older versions
            console.log(`  Found ${directLinkMatch.length} direct download links in page`);
            for (let i = 1; i < Math.min(directLinkMatch.length, 5); i++) {
                const url = directLinkMatch[i];
                // Try to verify this URL works
                try {
                    const checkResp = await axios.head(url, { headers, timeout: 5000, maxRedirects: 5 });
                    const contentLength = parseInt(checkResp.headers['content-length'] || '0');
                    if (contentLength > 5000000) { // > 5MB, likely a real APK
                        console.log(`  ✓ Found working older APK URL (${Math.round(contentLength/1024/1024)}MB)`);
                        return {
                            success: true,
                            source: 'apkpure_older',
                            downloadUrl: url,
                            packageName: packageName,
                            appName: appName,
                            format: url.includes('XAPK') ? 'XAPK' : 'APK',
                            compatible: true,
                            isOlderVersion: true,
                            note: 'Older version from APKPure'
                        };
                    }
                } catch (e) {
                    continue;
                }
            }
        }
        
        console.log(`  Found ${versions.length} versions on page`);
        
        // Find a compatible version
        if (deviceInfo.apiLevel && versions.length > 0) {
            // Sort by version (newer first)
            versions.sort((a, b) => {
                const partsA = a.version.split('.').map(Number);
                const partsB = b.version.split('.').map(Number);
                for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
                    const diff = (partsB[i] || 0) - (partsA[i] || 0);
                    if (diff !== 0) return diff;
                }
                return 0;
            });
            
            // Find newest compatible version
            for (const ver of versions) {
                // If we know minSdk and it's compatible
                if (ver.minSdk && ver.minSdk <= deviceInfo.apiLevel) {
                    console.log(`  ✓ Compatible version found: ${ver.version} (minSdk ${ver.minSdk})`);
                    
                    // Try to get the actual download URL from the version page
                    const downloadUrl = await getApkPureDownloadUrl(ver.downloadLink, headers);
                    if (downloadUrl) {
                        return {
                            success: true,
                            source: 'apkpure_older',
                            downloadUrl: downloadUrl,
                            packageName: packageName,
                            appName: appName,
                            version: ver.version,
                            minSdk: ver.minSdk,
                            format: downloadUrl.includes('XAPK') ? 'XAPK' : 'APK',
                            compatible: true,
                            isOlderVersion: true,
                            note: `Version ${ver.version} compatible with Android ${getAndroidVersionName(deviceInfo.apiLevel)}`
                        };
                    }
                }
                
                // If minSdk unknown, try versions that look older (skip first few which are likely newer)
                if (!ver.minSdk && versions.indexOf(ver) > 2) {
                    const downloadUrl = await getApkPureDownloadUrl(ver.downloadLink, headers);
                    if (downloadUrl) {
                        // Try to download and see if it works
                        return {
                            success: true,
                            source: 'apkpure_older',
                            downloadUrl: downloadUrl,
                            packageName: packageName,
                            appName: appName,
                            version: ver.version,
                            format: downloadUrl.includes('XAPK') ? 'XAPK' : 'APK',
                            compatible: true,
                            isOlderVersion: true,
                            note: `Older version ${ver.version} (compatibility unknown, may work)`
                        };
                    }
                }
            }
        }
        
        return { success: false };

    } catch (error) {
        console.log(`  APKPure scraping error: ${error.message}`);
        return { success: false };
    }
}

// ============================================================
// GET APKPURE DOWNLOAD URL
// Navigate to a version page and extract the direct download URL
// ============================================================

async function getApkPureDownloadUrl(pageUrl, headers) {
    try {
        const resp = await axios.get(pageUrl, { headers, timeout: 10000 });
        const $ = cheerio.load(resp.data);
        
        // Look for direct download link
        let downloadUrl = $('a[href*="d.apkpure.com"]').attr('href');
        
        if (!downloadUrl) {
            // Look for download button
            downloadUrl = $('a.download-btn, a.da, a[href*="download"]').attr('href');
        }
        
        if (!downloadUrl) {
            // Search in page content for direct URL
            const match = resp.data.match(/https:\/\/d\.apkpure\.com\/b\/(?:APK|XAPK)\/[^"'\s<>]+/);
            if (match) {
                downloadUrl = match[0];
            }
        }
        
        if (downloadUrl && downloadUrl.includes('d.apkpure.com')) {
            return downloadUrl;
        }
        
        return null;
    } catch (e) {
        return null;
    }
}

// ============================================================
// BASIC APKMIRROR
// ============================================================

async function tryApkMirror(packageName) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };

        const searchUrl = `https://www.apkmirror.com/?post_type=app_release&searchtype=app&s=${packageName}`;
        const searchResp = await axios.get(searchUrl, { headers, timeout: 15000 });
        const $ = cheerio.load(searchResp.data);
        
        const appLink = $('div.appRow h5.appRowTitle a').first().attr('href');
        
        if (!appLink) {
            return { success: false };
        }

        return {
            success: true,
            source: 'apkmirror',
            downloadUrl: `https://www.apkmirror.com${appLink}`,
            packageName: packageName,
            note: 'APKMirror page - manual download required'
        };

    } catch (error) {
        return { success: false };
    }
}

// ============================================================
// COMPATIBILITY CHECK ENDPOINT
// ============================================================

app.get('/check-compatibility/:packageName', async (req, res) => {
    const packageName = req.params.packageName;
    const deviceInfo = getDeviceInfo(req);
    
    if (!deviceInfo.apiLevel) {
        return res.status(400).json({
            error: 'Missing apiLevel parameter'
        });
    }
    
    try {
        const appData = await gplay.app({ appId: packageName });
        
        let minSdk = null;
        let compatible = true;
        
        if (appData.androidVersion && !appData.androidVersion.includes('Varies')) {
            minSdk = androidVersionToApi(appData.androidVersion);
            compatible = !minSdk || minSdk <= deviceInfo.apiLevel;
        }
        
        res.json({
            success: true,
            packageName: packageName,
            appName: appData.title,
            compatible: compatible,
            appRequirements: {
                minAndroidVersion: appData.androidVersion,
                minSdk: minSdk
            },
            device: {
                apiLevel: deviceInfo.apiLevel,
                androidVersion: getAndroidVersionName(deviceInfo.apiLevel)
            },
            message: compatible ? 
                'App should be compatible' :
                `Requires Android ${appData.androidVersion}. Will try to find older version.`
        });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// PROXY DOWNLOAD
// ============================================================

app.get('/download-apk/:packageName', async (req, res) => {
    const packageName = req.params.packageName;
    
    try {
        const downloadUrl = `https://d.apkpure.com/b/XAPK/${packageName}?version=latest`;
        
        const response = await axios({
            method: 'GET',
            url: downloadUrl,
            responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 300000,
            maxRedirects: 10
        });

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${packageName}.xapk"`);
        
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }
        
        response.data.pipe(res);

    } catch (error) {
        res.status(500).json({ error: 'Download failed', message: error.message });
    }
});

// ============================================================
// SEARCH WITH APK URLs
// ============================================================

app.get('/search-with-apk/:query', async (req, res) => {
    const deviceInfo = getDeviceInfo(req);
    
    try {
        const results = await gplay.search({ term: req.params.query, num: 15 });
        
        const queryString = deviceInfo.apiLevel ? 
            `?apiLevel=${deviceInfo.apiLevel}${deviceInfo.arch ? `&arch=${deviceInfo.arch}` : ''}` : '';
        
        const appsWithApk = results.map(app => ({
            name: app.title,
            packageName: app.appId || null,
            developer: app.developer,
            icon: app.icon,
            rating: app.score,
            installs: app.installs,
            free: app.free,
            androidVersion: app.androidVersion,
            apkUrl: app.appId ? 
                `https://kosher-store-backend.onrender.com/apk-url/${app.appId}${queryString}` : null
        }));
        
        res.json({ success: true, results: appsWithApk });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Kosher Store Backend v4.4 running on port ${PORT}`);
    console.log('Improved APKPure scraping for older versions');
});
