const express = require('express');
const cors = require('cors');
const gplay = require('google-play-scraper');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ============================================================
// OLDER VERSIONS DATABASE
// Manually maintained list of working older version URLs
// ============================================================

const OLDER_VERSIONS_DB = {
    'com.openai.chatgpt': {
        name: 'ChatGPT',
        latestRequiresApi: 32,
        olderVersions: [
            // These are version codes for APKPure downloads
            // Format: versionCode that works with d.apkpure.net
            { version: '1.2024.311', minApi: 24, maxApi: 31, versionCode: '10243110' },
            { version: '1.2024.220', minApi: 24, maxApi: 30, versionCode: '10242200' },
            { version: '1.2024.150', minApi: 21, maxApi: 29, versionCode: '10241500' }
        ]
    }
};

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/', (req, res) => {
    res.json({
        status: 'Kosher Store Backend Running',
        version: '4.5.0',
        features: [
            'Device-aware APK filtering',
            'Automatic older version fallback',
            'Proxy download for older versions',
            'Hardcoded older versions for known apps'
        ],
        knownAppsWithOlderVersions: Object.keys(OLDER_VERSIONS_DB)
    });
});

// ============================================================
// HELPERS
// ============================================================

function getDeviceInfo(req) {
    return {
        apiLevel: parseInt(req.query.apiLevel) || null,
        arch: req.query.arch || null,
        needsOlderVersion: req.query.needsOlderVersion === 'true'
    };
}

function getAndroidVersionName(apiLevel) {
    const versions = {
        21: '5.0', 22: '5.1', 23: '6.0', 24: '7.0', 25: '7.1',
        26: '8.0', 27: '8.1', 28: '9', 29: '10', 30: '11',
        31: '12', 32: '12L', 33: '13', 34: '14', 35: '15'
    };
    return versions[apiLevel] || String(apiLevel);
}

function androidVersionToApi(versionStr) {
    if (!versionStr) return null;
    const mapping = {
        '5.0': 21, '6.0': 23, '7.0': 24, '8.0': 26, '8.1': 27,
        '9': 28, '10': 29, '11': 30, '12': 31, '13': 33, '14': 34
    };
    if (mapping[versionStr]) return mapping[versionStr];
    const num = parseFloat(versionStr);
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
// MAIN APK URL ENDPOINT
// ============================================================

app.get('/apk-url/:packageName', async (req, res) => {
    const packageName = req.params.packageName;
    const deviceInfo = getDeviceInfo(req);
    
    console.log(`\n=== APK: ${packageName} | API: ${deviceInfo.apiLevel} | needsOlder: ${deviceInfo.needsOlderVersion} ===`);
    
    try {
        // Get app info from Play Store
        let appName = packageName;
        let minSdkFromStore = null;
        
        try {
            const appInfo = await gplay.app({ appId: packageName });
            appName = appInfo.title || packageName;
            if (appInfo.androidVersion && !appInfo.androidVersion.includes('Varies')) {
                minSdkFromStore = androidVersionToApi(appInfo.androidVersion);
            }
        } catch (e) {}

        const needsOlder = deviceInfo.needsOlderVersion;

        // ================================================================
        // OLDER VERSION PATH - When client requests older version
        // ================================================================
        if (needsOlder && deviceInfo.apiLevel) {
            console.log('→ Looking for older version...');
            
            // Check our hardcoded database first
            const knownApp = OLDER_VERSIONS_DB[packageName];
            if (knownApp && knownApp.olderVersions) {
                // Find version that fits device's API level
                const match = knownApp.olderVersions.find(v => 
                    deviceInfo.apiLevel >= v.minApi && deviceInfo.apiLevel <= v.maxApi
                );
                
                if (match) {
                    console.log(`✓ Found hardcoded: v${match.version} for API ${deviceInfo.apiLevel}`);
                    
                    // Use proxy download
                    const directUrl = `https://d.apkpure.net/b/APK/${packageName}?versionCode=${match.versionCode}`;
                    const proxyUrl = `https://kosher-store-backend.onrender.com/proxy-download?url=${encodeURIComponent(directUrl)}&pkg=${packageName}&ver=${match.version}`;
                    
                    return res.json({
                        success: true,
                        compatible: true,
                        source: 'older_version_db',
                        downloadUrl: proxyUrl,
                        packageName: packageName,
                        appName: knownApp.name,
                        version: match.version,
                        minSdk: match.minApi,
                        format: 'APK',
                        isOlderVersion: true
                    });
                }
            }
            
            // Try brute force version codes for unknown apps
            console.log('→ Trying version codes...');
            const olderResult = await tryOlderVersionCodes(packageName, deviceInfo.apiLevel);
            if (olderResult) {
                return res.json(olderResult);
            }
            
            // Failed to find older version
            console.log('✗ No older version found');
            return res.json({
                success: false,
                compatible: false,
                error: `Could not find an older version of ${appName} compatible with Android ${getAndroidVersionName(deviceInfo.apiLevel)}.`,
                packageName: packageName,
                appName: appName,
                deviceApiLevel: deviceInfo.apiLevel
            });
        }

        // ================================================================
        // LATEST VERSION PATH
        // ================================================================
        console.log('→ Trying latest version...');
        
        // Try APKPure XAPK first
        const xapkUrl = `https://d.apkpure.com/b/XAPK/${packageName}?version=latest`;
        try {
            await axios.head(xapkUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 10000
            });
            console.log('✓ APKPure XAPK');
            return res.json({
                success: true,
                compatible: true,
                source: 'apkpure',
                downloadUrl: xapkUrl,
                packageName: packageName,
                format: 'XAPK',
                version: 'latest',
                canRetryWithOlderVersion: true
            });
        } catch (e) {}
        
        // Try APKPure APK
        const apkUrl = `https://d.apkpure.com/b/APK/${packageName}?version=latest`;
        try {
            await axios.head(apkUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
            console.log('✓ APKPure APK');
            return res.json({
                success: true,
                compatible: true,
                source: 'apkpure',
                downloadUrl: apkUrl,
                packageName: packageName,
                format: 'APK',
                version: 'latest',
                canRetryWithOlderVersion: true
            });
        } catch (e) {}

        // Failed
        console.log('✗ No source found');
        res.json({
            success: false,
            error: 'Could not find APK download',
            packageName: packageName
        });
        
    } catch (error) {
        console.error('Error:', error.message);
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// TRY OLDER VERSION CODES
// ============================================================

async function tryOlderVersionCodes(packageName, deviceApiLevel) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
    };
    
    // Common version code patterns to try
    const versionCodes = [
        '10243000', '10242000', '10241000', '10240000',
        '10235000', '10230000', '10225000', '10220000',
        '10215000', '10210000', '10205000', '10200000'
    ];
    
    for (const code of versionCodes) {
        const url = `https://d.apkpure.net/b/APK/${packageName}?versionCode=${code}`;
        
        try {
            const resp = await axios.head(url, { 
                headers, 
                timeout: 5000,
                validateStatus: s => s < 400 
            });
            
            const size = parseInt(resp.headers['content-length'] || '0');
            if (size > 1000000) { // > 1MB = real APK
                console.log(`✓ Found version code ${code} (${Math.round(size/1024/1024)}MB)`);
                
                const proxyUrl = `https://kosher-store-backend.onrender.com/proxy-download?url=${encodeURIComponent(url)}&pkg=${packageName}&ver=${code}`;
                
                return {
                    success: true,
                    compatible: true,
                    source: 'apkpure_versioncode',
                    downloadUrl: proxyUrl,
                    packageName: packageName,
                    version: code,
                    format: 'APK',
                    isOlderVersion: true
                };
            }
        } catch (e) {}
    }
    
    return null;
}

// ============================================================
// PROXY DOWNLOAD ENDPOINT
// ============================================================

app.get('/proxy-download', async (req, res) => {
    const url = req.query.url;
    const pkg = req.query.pkg || 'app';
    const ver = req.query.ver || 'unknown';
    
    if (!url) {
        return res.status(400).json({ error: 'Missing url' });
    }
    
    console.log(`\n=== PROXY: ${pkg} v${ver} ===`);
    console.log(`URL: ${url}`);
    
    try {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
                'Accept': '*/*'
            },
            timeout: 300000,
            maxRedirects: 10
        });
        
        const filename = `${pkg}_${ver}.apk`;
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
            console.log(`Size: ${Math.round(parseInt(response.headers['content-length'])/1024/1024)}MB`);
        }
        
        response.data.pipe(res);
        
    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(500).json({ error: 'Download failed', message: error.message });
    }
});

// ============================================================
// OTHER ENDPOINTS
// ============================================================

app.get('/app/:packageName', async (req, res) => {
    try {
        const appData = await gplay.app({ appId: req.params.packageName });
        res.json({ success: true, app: appData });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/search/:query', async (req, res) => {
    try {
        const results = await gplay.search({ term: req.params.query, num: 20 });
        res.json({ success: true, results: results.map(a => ({
            name: a.title, packageName: a.appId, developer: a.developer,
            icon: a.icon, rating: a.score, installs: a.installs
        }))});
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Kosher Store Backend v4.5 on port ${PORT}`);
    console.log('Older versions DB:', Object.keys(OLDER_VERSIONS_DB));
});
