const express = require('express');
const cors = require('cors');
const gplay = require('google-play-scraper');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ============================================================
// KNOWN OLDER VERSIONS FOR PROBLEMATIC APPS
// These apps have newer versions that require higher API levels
// We maintain direct download links for older compatible versions
// ============================================================

const KNOWN_OLDER_VERSIONS = {
    'com.openai.chatgpt': {
        // ChatGPT latest requires API 32, but older versions work on API 21+
        name: 'ChatGPT',
        olderVersions: [
            {
                maxApiLevel: 31, // For devices with API 31 or lower
                version: '1.2024.122',
                // APKPure direct download for specific version
                downloadUrl: 'https://d.apkpure.com/b/APK/com.openai.chatgpt?versionCode=10241220',
                minSdk: 24,
                format: 'APK'
            },
            {
                maxApiLevel: 30, // For devices with API 30 or lower (Android 11)
                version: '1.2024.052',
                downloadUrl: 'https://d.apkpure.com/b/APK/com.openai.chatgpt?versionCode=10240520',
                minSdk: 24,
                format: 'APK'
            },
            {
                maxApiLevel: 28, // For devices with API 28 or lower (Android 9)
                version: '1.2023.352',
                downloadUrl: 'https://d.apkpure.com/b/APK/com.openai.chatgpt?versionCode=10233520',
                minSdk: 21,
                format: 'APK'
            }
        ]
    },
    // Add more apps here as needed
};

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'Kosher Store Backend Running',
        version: '4.3.0',
        features: [
            'Device-aware APK filtering',
            'minSdk compatibility checks',
            'Automatic older version fallback with ?needsOlderVersion=true',
            'Hardcoded older versions for known problematic apps',
            'APKMirror/APKPure scraping fallback'
        ],
        knownOlderVersions: Object.keys(KNOWN_OLDER_VERSIONS),
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
        '8.0': 26, '8.1': 27, '9': 28, '9.0': 28, '10': 29, '11': 30,
        '12': 31, '12L': 32, '13': 33, '14': 34, '15': 35
    };
    
    if (mapping[versionStr]) return mapping[versionStr];
    
    const num = parseFloat(versionStr);
    if (isNaN(num)) return null;
    
    if (num >= 4 && num < 5) return 19;
    if (num >= 5 && num < 6) return 21;
    if (num >= 6 && num < 7) return 23;
    if (num >= 7 && num < 8) return 24;
    if (num >= 8 && num < 9) return 26;
    if (num >= 9 && num < 10) return 28;
    if (num >= 10 && num < 11) return 29;
    if (num >= 11 && num < 12) return 30;
    if (num >= 12 && num < 13) return 31;
    if (num >= 13 && num < 14) return 33;
    if (num >= 14 && num < 15) return 34;
    if (num >= 15) return 35;
    
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
            
            // FIRST: Check if we have a known older version for this app
            const knownApp = KNOWN_OLDER_VERSIONS[packageName];
            if (knownApp && deviceInfo.apiLevel) {
                console.log(`  Found ${packageName} in known older versions list`);
                
                // Find the best version for this device's API level
                const compatibleVersion = knownApp.olderVersions.find(v => 
                    deviceInfo.apiLevel <= v.maxApiLevel && 
                    (!v.minSdk || deviceInfo.apiLevel >= v.minSdk)
                );
                
                if (compatibleVersion) {
                    console.log(`  ✓ Using known older version: ${compatibleVersion.version}`);
                    
                    // Verify the URL still works
                    try {
                        await axios.head(compatibleVersion.downloadUrl, {
                            headers: { 'User-Agent': 'Mozilla/5.0' },
                            timeout: 10000,
                            maxRedirects: 5
                        });
                        
                        return res.json({
                            success: true,
                            source: 'known_older_version',
                            downloadUrl: compatibleVersion.downloadUrl,
                            packageName: packageName,
                            appName: knownApp.name,
                            version: compatibleVersion.version,
                            minSdk: compatibleVersion.minSdk,
                            format: compatibleVersion.format || 'APK',
                            compatible: true,
                            isOlderVersion: true,
                            note: `Older version ${compatibleVersion.version} compatible with Android ${getAndroidVersionName(deviceInfo.apiLevel)}`
                        });
                    } catch (e) {
                        console.log(`  Known version URL failed: ${e.message}, trying alternatives...`);
                    }
                }
            }
            
            // SECOND: Try APKPure with specific version parameter
            console.log('  Trying APKPure older versions...');
            const apkpureResult = await tryApkPureOlderVersion(packageName, deviceInfo);
            if (apkpureResult.success) {
                return res.json(apkpureResult);
            }
            
            // THIRD: Try scraping APKMirror for actual download link
            console.log('  Trying APKMirror older versions...');
            const apkmirrorResult = await tryApkMirrorOlderVersion(packageName, deviceInfo, appName);
            if (apkmirrorResult.success) {
                return res.json(apkmirrorResult);
            }
            
            // FAILED: No older version found
            console.log('✗ No compatible older version found');
            return res.json({
                success: false,
                compatible: false,
                error: `${appName} requires Android ${getAndroidVersionName(minSdkFromStore || 32)}+. No older compatible version was found for Android ${getAndroidVersionName(deviceInfo.apiLevel)}.`,
                packageName: packageName,
                appName: appName,
                deviceApiLevel: deviceInfo.apiLevel,
                suggestion: 'This app may not have an older version compatible with your device.'
            });
        }

        // ============================================================
        // LATEST VERSION PATH (for compatible devices)
        // ============================================================
        console.log('Trying latest version...');
        
        // Try APKPure XAPK
        const xapkUrl = `https://d.apkpure.com/b/XAPK/${packageName}?version=latest`;
        try {
            await axios.head(xapkUrl, {
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

        // Try APKMirror
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
// TRY APKPURE OLDER VERSION
// Uses APKPure's version-specific download URLs
// ============================================================

async function tryApkPureOlderVersion(packageName, deviceInfo) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    try {
        // Try a few older version codes (these are estimates based on common patterns)
        // APKPure version codes are usually: versionName without dots + build number
        const versionCodesToTry = [
            '10241220', // ~v1.2024.122
            '10240520', // ~v1.2024.052
            '10233520', // ~v1.2023.352
            '10232000', // ~v1.2023.200
            '10231000', // ~v1.2023.100
        ];

        for (const versionCode of versionCodesToTry) {
            const url = `https://d.apkpure.com/b/APK/${packageName}?versionCode=${versionCode}`;
            
            try {
                const response = await axios.head(url, { 
                    headers, 
                    timeout: 8000,
                    maxRedirects: 5,
                    validateStatus: (status) => status < 400
                });
                
                // Check if we got a valid APK response (not HTML error page)
                const contentType = response.headers['content-type'] || '';
                const contentLength = parseInt(response.headers['content-length'] || '0');
                
                if (contentLength > 1000000) { // > 1MB, likely a real APK
                    console.log(`  ✓ Found APKPure version ${versionCode} (${Math.round(contentLength/1024/1024)}MB)`);
                    return {
                        success: true,
                        source: 'apkpure_older',
                        downloadUrl: url,
                        packageName: packageName,
                        version: versionCode,
                        format: 'APK',
                        compatible: true,
                        isOlderVersion: true,
                        note: `Older APK version`
                    };
                }
            } catch (e) {
                // This version doesn't exist, try next
                continue;
            }
        }

        return { success: false };

    } catch (error) {
        console.log(`  APKPure older version error: ${error.message}`);
        return { success: false };
    }
}

// ============================================================
// TRY APKMIRROR OLDER VERSION - Get actual download link
// ============================================================

async function tryApkMirrorOlderVersion(packageName, deviceInfo, appName) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };

    try {
        // Search APKMirror
        const searchUrl = `https://www.apkmirror.com/?post_type=app_release&searchtype=app&s=${packageName}`;
        console.log(`    Searching APKMirror...`);
        
        const searchResp = await axios.get(searchUrl, { headers, timeout: 15000 });
        const $search = cheerio.load(searchResp.data);
        
        // Find app page
        const appLink = $search('div.appRow h5.appRowTitle a').first().attr('href');
        if (!appLink) {
            console.log('    App not found on APKMirror');
            return { success: false };
        }

        // Go to app page
        const appUrl = `https://www.apkmirror.com${appLink}`;
        console.log(`    Found app page: ${appUrl}`);
        
        const appResp = await axios.get(appUrl, { headers, timeout: 15000 });
        const $app = cheerio.load(appResp.data);
        
        // Find version links - look for older versions
        const versionLinks = [];
        $app('div.listWidget div.appRow').each((i, el) => {
            const $el = $app(el);
            const link = $el.find('a.downloadLink').first().attr('href') || 
                        $el.find('h5 a').first().attr('href');
            const text = $el.text();
            
            if (link && link.includes('/apk/')) {
                // Try to extract minAPI from the text
                const minApiMatch = text.match(/minAPI[:\s]*(\d+)/i);
                const minSdk = minApiMatch ? parseInt(minApiMatch[1]) : null;
                
                versionLinks.push({
                    link: `https://www.apkmirror.com${link}`,
                    minSdk: minSdk,
                    text: text.substring(0, 100)
                });
            }
        });

        console.log(`    Found ${versionLinks.length} version links`);

        // Find a compatible version
        for (const version of versionLinks) {
            if (version.minSdk && deviceInfo.apiLevel && version.minSdk > deviceInfo.apiLevel) {
                continue; // Skip incompatible versions
            }

            // Try to get the actual download page
            try {
                const versionResp = await axios.get(version.link, { headers, timeout: 10000 });
                const $version = cheerio.load(versionResp.data);
                
                // Look for download button/link
                let downloadPageLink = $version('a.downloadButton').attr('href') ||
                                       $version('a[href*="download"]').first().attr('href');
                
                if (downloadPageLink && !downloadPageLink.startsWith('http')) {
                    downloadPageLink = `https://www.apkmirror.com${downloadPageLink}`;
                }

                if (downloadPageLink) {
                    // Get the final download page
                    const downloadResp = await axios.get(downloadPageLink, { headers, timeout: 10000 });
                    const $download = cheerio.load(downloadResp.data);
                    
                    // Find the actual APK download link
                    let apkLink = $download('a[href*=".apk"]').first().attr('href') ||
                                 $download('a.downloadButton').attr('href');
                    
                    if (apkLink) {
                        if (!apkLink.startsWith('http')) {
                            apkLink = `https://www.apkmirror.com${apkLink}`;
                        }
                        
                        console.log(`    ✓ Found APKMirror download: ${apkLink}`);
                        return {
                            success: true,
                            source: 'apkmirror_older',
                            downloadUrl: apkLink,
                            packageName: packageName,
                            appName: appName,
                            minSdk: version.minSdk,
                            compatible: true,
                            isOlderVersion: true,
                            note: 'Older version from APKMirror'
                        };
                    }
                }
            } catch (e) {
                console.log(`    Failed to get download for version: ${e.message}`);
                continue;
            }
        }

        return { success: false };

    } catch (error) {
        console.log(`    APKMirror older version error: ${error.message}`);
        return { success: false };
    }
}

// ============================================================
// BASIC APKMIRROR (latest) - Returns page URL not direct download
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
            note: 'APKMirror page - requires manual download'
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

        // Check if we have a known older version
        const hasOlderVersion = !!KNOWN_OLDER_VERSIONS[packageName];
        
        res.json({
            success: true,
            packageName: packageName,
            appName: appData.title,
            compatible: compatible,
            hasKnownOlderVersion: hasOlderVersion,
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
                hasOlderVersion ?
                    `Latest requires Android ${appData.androidVersion}, but an older compatible version is available.` :
                    `Requires Android ${appData.androidVersion}. No older version available.`
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
    console.log(`Kosher Store Backend v4.3 running on port ${PORT}`);
    console.log('NEW: Hardcoded older versions for known problematic apps (ChatGPT, etc.)');
    console.log('NEW: Better APKPure version-specific downloads');
});
