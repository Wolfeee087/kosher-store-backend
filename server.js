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
        version: '4.2.0',
        features: [
            'Device-aware APK filtering',
            'minSdk compatibility checks',
            'Automatic older version fallback with ?needsOlderVersion=true',
            'APKMirror version history support'
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
// Supports ?needsOlderVersion=true for automatic retry after install failure
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
        
        // If client says latest didn't work OR Play Store says incompatible, find older version
        if (mustFindOlderVersion) {
            console.log('Searching for older compatible version...');
            
            // Try APKMirror first (better version history)
            let result = await findOlderVersionApkMirror(packageName, deviceInfo, appName);
            if (result.success) {
                return res.json(result);
            }
            
            // Try APKPure version history
            result = await findOlderVersionApkPure(packageName, deviceInfo, appName);
            if (result.success) {
                return res.json(result);
            }
            
            // No older version found automatically - return APKMirror page as fallback
            console.log('✗ No compatible older version found automatically');
            console.log('  Returning APKMirror page URL as fallback');
            return res.json({
                success: true,
                source: 'apkmirror_manual',
                downloadUrl: `https://www.apkmirror.com/?post_type=app_release&searchtype=apk&s=${packageName}`,
                packageName: packageName,
                appName: appName,
                compatible: true,
                isOlderVersion: true,
                note: 'Please select an older version compatible with your device from APKMirror'
            });
        }

        // Try latest version first (for compatible devices)
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
// FIND OLDER VERSION - APKMirror
// ============================================================

async function findOlderVersionApkMirror(packageName, deviceInfo, appName) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };

    try {
        // Search APKMirror
        const searchUrl = `https://www.apkmirror.com/?post_type=app_release&searchtype=app&s=${packageName}`;
        console.log(`  Searching APKMirror...`);
        
        const searchResp = await axios.get(searchUrl, { headers, timeout: 15000 });
        const $search = cheerio.load(searchResp.data);
        
        // Find app page
        const appLink = $search('div.appRow h5.appRowTitle a').first().attr('href');
        if (!appLink) {
            console.log('  App not found on APKMirror');
            return { success: false };
        }

        // Go to app page to see versions
        const appUrl = `https://www.apkmirror.com${appLink}`;
        console.log(`  Found: ${appUrl}`);
        
        const appResp = await axios.get(appUrl, { headers, timeout: 15000 });
        const $app = cheerio.load(appResp.data);
        
        // Collect all version entries
        const versions = [];
        
        // APKMirror shows recent versions on the app page
        $app('.listWidget .appRow').each((i, el) => {
            const $el = $app(el);
            const link = $el.find('a.downloadLink, a[href*="/apk/"]').first().attr('href');
            const text = $el.text();
            
            if (!link) return;
            
            // Look for minAPI in the version info
            const minApiMatch = text.match(/minAPI[:\s]*(\d+)/i);
            const androidMatch = text.match(/Android[:\s]*(\d+\.?\d*)\+?/i);
            const versionMatch = text.match(/(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)/);
            
            let minSdk = null;
            if (minApiMatch) {
                minSdk = parseInt(minApiMatch[1]);
            } else if (androidMatch) {
                minSdk = androidVersionToApi(androidMatch[1]);
            }
            
            versions.push({
                version: versionMatch ? versionMatch[1] : null,
                minSdk: minSdk,
                link: `https://www.apkmirror.com${link}`,
                text: text.substring(0, 80).trim()
            });
        });

        console.log(`  Found ${versions.length} versions`);

        // Find newest compatible version
        if (deviceInfo.apiLevel && versions.length > 0) {
            const compatible = versions.find(v => !v.minSdk || v.minSdk <= deviceInfo.apiLevel);
            
            if (compatible) {
                console.log(`  ✓ Compatible: ${compatible.version || 'unknown'} (minAPI: ${compatible.minSdk || '?'})`);
                return {
                    success: true,
                    source: 'apkmirror_older',
                    downloadUrl: compatible.link,
                    packageName: packageName,
                    appName: appName,
                    version: compatible.version,
                    minSdk: compatible.minSdk,
                    compatible: true,
                    isOlderVersion: true,
                    note: 'Older compatible version - click download on APKMirror page'
                };
            }
        }

        // No compatible version found, but return the page anyway
        if (versions.length > 0) {
            return {
                success: true,
                source: 'apkmirror',
                downloadUrl: appUrl,
                packageName: packageName,
                note: 'APKMirror page - manually select a compatible version'
            };
        }

        return { success: false };

    } catch (error) {
        console.log(`  APKMirror error: ${error.message}`);
        return { success: false };
    }
}

// ============================================================
// FIND OLDER VERSION - APKPure
// ============================================================

async function findOlderVersionApkPure(packageName, deviceInfo, appName) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    try {
        // Search APKPure
        const searchUrl = `https://apkpure.com/search?q=${packageName}`;
        console.log(`  Searching APKPure versions...`);
        
        const searchResp = await axios.get(searchUrl, { headers, timeout: 15000 });
        const $ = cheerio.load(searchResp.data);
        
        // Find app link
        let appPath = null;
        $('a.first-info, a[href*="' + packageName + '"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && (href.includes(packageName) || !appPath)) {
                appPath = href;
                if (href.includes(packageName)) return false;
            }
        });
        
        if (!appPath) {
            console.log('  App not found on APKPure');
            return { success: false };
        }

        // Go to versions page
        const baseUrl = appPath.startsWith('http') ? appPath : `https://apkpure.com${appPath}`;
        const versionsUrl = baseUrl.replace(/\/$/, '') + '/versions';
        console.log(`  Checking: ${versionsUrl}`);
        
        const versionsResp = await axios.get(versionsUrl, { headers, timeout: 15000 });
        const $v = cheerio.load(versionsResp.data);
        
        // Parse versions
        const versions = [];
        
        $v('.ver-item, .version-item, ul.ver-wrap li, div[class*="ver"]').each((i, el) => {
            const $el = $v(el);
            const text = $el.text();
            const link = $el.find('a').first().attr('href');
            
            if (!link || !text) return;
            
            // Parse Android requirement
            const reqMatch = text.match(/(?:Android|Requires)[:\s]*(\d+\.?\d*)/i);
            const verMatch = text.match(/(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)/);
            
            if (verMatch) {
                versions.push({
                    version: verMatch[1],
                    minSdk: reqMatch ? androidVersionToApi(reqMatch[1]) : null,
                    link: link.startsWith('http') ? link : `https://apkpure.com${link}`,
                    text: text.substring(0, 60).trim()
                });
            }
        });
        
        console.log(`  Found ${versions.length} versions on APKPure`);
        
        // Find compatible version
        if (deviceInfo.apiLevel && versions.length > 0) {
            const compatible = versions.find(v => !v.minSdk || v.minSdk <= deviceInfo.apiLevel);
            
            if (compatible) {
                console.log(`  ✓ Compatible: v${compatible.version} (minSdk: ${compatible.minSdk || '?'})`);
                return {
                    success: true,
                    source: 'apkpure_older',
                    downloadUrl: compatible.link,
                    packageName: packageName,
                    appName: appName,
                    version: compatible.version,
                    minSdk: compatible.minSdk,
                    compatible: true,
                    isOlderVersion: true,
                    note: 'Older compatible version from APKPure'
                };
            }
        }
        
        return { success: false };
        
    } catch (error) {
        console.log(`  APKPure versions error: ${error.message}`);
        return { success: false };
    }
}

// ============================================================
// BASIC APKMirror (latest)
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
            note: 'APKMirror page'
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
                `Requires Android ${appData.androidVersion}. An older version may work.`
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
    console.log(`Kosher Store Backend v4.2 running on port ${PORT}`);
    console.log('NEW: ?needsOlderVersion=true parameter for automatic retry');
    console.log('Phone can retry with older version if INSTALL_FAILED_OLDER_SDK');
});
