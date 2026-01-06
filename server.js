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
        version: '4.0.0',
        features: ['Device-aware APK filtering', 'minSdk compatibility checks'],
        endpoints: [
            '/app/:packageName',
            '/search/:query',
            '/search/:query?apiLevel=30&arch=arm64-v8a',
            '/apk-url/:packageName',
            '/apk-url/:packageName?apiLevel=30&arch=arm64-v8a',
            '/download-apk/:packageName'
        ]
    });
});

// ============================================================
// DEVICE COMPATIBILITY HELPERS
// ============================================================

/**
 * Parse device info from query parameters
 */
function getDeviceInfo(req) {
    return {
        apiLevel: parseInt(req.query.apiLevel) || null,
        arch: req.query.arch || null,  // arm64-v8a, armeabi-v7a, x86, x86_64
        dpi: req.query.dpi || null,    // mdpi, hdpi, xhdpi, xxhdpi, xxxhdpi
        androidVersion: req.query.androidVersion || null
    };
}

/**
 * Get Android version name from API level
 */
function getAndroidVersionName(apiLevel) {
    const versions = {
        21: '5.0', 22: '5.1', 23: '6.0', 24: '7.0', 25: '7.1',
        26: '8.0', 27: '8.1', 28: '9', 29: '10', 30: '11',
        31: '12', 32: '12L', 33: '13', 34: '14', 35: '15'
    };
    return versions[apiLevel] || apiLevel.toString();
}

/**
 * Check if app's minSdk is compatible with device
 */
function isCompatible(appMinSdk, deviceApiLevel) {
    if (!deviceApiLevel || !appMinSdk) return true; // Can't check, assume compatible
    return deviceApiLevel >= appMinSdk;
}

// ============================================================
// APP DETAILS ENDPOINT
// ============================================================

app.get('/app/:packageName', async (req, res) => {
    const deviceInfo = getDeviceInfo(req);
    
    try {
        const appData = await gplay.app({ appId: req.params.packageName });
        
        // Check compatibility if device info provided
        let compatible = true;
        let compatibilityMessage = null;
        
        if (deviceInfo.apiLevel && appData.minInstalls) {
            // google-play-scraper doesn't give us minSdk directly
            // We'll check this during APK fetch instead
        }
        
        res.json({ 
            success: true, 
            app: appData,
            deviceInfo: deviceInfo.apiLevel ? deviceInfo : undefined
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// SEARCH ENDPOINT - Now with compatibility info
// ============================================================

app.get('/search/:query', async (req, res) => {
    const deviceInfo = getDeviceInfo(req);
    
    try {
        const results = await gplay.search({
            term: req.params.query,
            num: 20  // Fetch more to filter incompatible ones
        });
        
        const simplified = results.map(app => {
            let packageName = app.appId;
            if (!packageName && app.url) {
                const match = app.url.match(/id=([^&]+)/);
                if (match) packageName = match[1];
            }
            
            return {
                name: app.title,
                packageName: packageName || null,
                developer: app.developer,
                icon: app.icon,
                rating: app.score,
                installs: app.installs,
                free: app.free,
                // Include Android requirement from Play Store if available
                androidVersion: app.androidVersion || null,
                androidVersionText: app.androidVersionText || null
            };
        });
        
        res.json({ 
            success: true, 
            results: simplified,
            deviceInfo: deviceInfo.apiLevel ? {
                apiLevel: deviceInfo.apiLevel,
                androidVersion: getAndroidVersionName(deviceInfo.apiLevel),
                note: 'Apps will be checked for compatibility during download'
            } : undefined
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// MAIN APK URL ENDPOINT - Now with device-aware filtering
// ============================================================

app.get('/apk-url/:packageName', async (req, res) => {
    const packageName = req.params.packageName;
    const deviceInfo = getDeviceInfo(req);
    
    console.log(`\n=== Fetching APK for: ${packageName} ===`);
    if (deviceInfo.apiLevel) {
        console.log(`Device: API ${deviceInfo.apiLevel} (Android ${getAndroidVersionName(deviceInfo.apiLevel)}), Arch: ${deviceInfo.arch || 'any'}`);
    }
    
    try {
        // First, try to get app info to check compatibility
        let appInfo = null;
        let minSdkFromStore = null;
        
        try {
            appInfo = await gplay.app({ appId: packageName });
            // androidVersion field contains minSdk requirement like "5.0" or "Varies with device"
            if (appInfo.androidVersion && !appInfo.androidVersion.includes('Varies')) {
                // Parse "5.0" to API level 21, "11" to API 30, etc.
                minSdkFromStore = androidVersionToApi(appInfo.androidVersion);
            }
        } catch (e) {
            console.log('Could not fetch Play Store info for compatibility check');
        }

        // Method 1: Try APKPure with version filtering
        console.log('Trying APKPure with compatibility check...');
        let result = await tryApkPureWithCompatibility(packageName, deviceInfo);
        if (result.success) {
            return res.json(result);
        }

        // Method 2: Try APKMirror with version filtering
        console.log('Trying APKMirror with compatibility...');
        result = await tryApkMirrorWithCompatibility(packageName, deviceInfo);
        if (result.success) {
            return res.json(result);
        }

        // Method 3: Fallback to basic APKPure (no version filtering)
        console.log('Trying APKPure basic (latest version)...');
        result = await tryApkPureBasic(packageName);
        if (result.success) {
            // Add compatibility warning if we know the app might be incompatible
            if (minSdkFromStore && deviceInfo.apiLevel && minSdkFromStore > deviceInfo.apiLevel) {
                result.compatible = false;
                result.compatibilityWarning = `This app requires Android ${getAndroidVersionName(minSdkFromStore)} (API ${minSdkFromStore}). Your device runs Android ${getAndroidVersionName(deviceInfo.apiLevel)} (API ${deviceInfo.apiLevel}).`;
            }
            return res.json(result);
        }

        // Method 4: APKCombo
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
            packageName: packageName,
            deviceInfo: deviceInfo.apiLevel ? deviceInfo : undefined
        });
        
    } catch (error) {
        console.error(`Error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// APK SOURCE METHODS WITH COMPATIBILITY
// ============================================================

/**
 * Convert Android version string to API level
 * "5.0" -> 21, "11" -> 30, "12" -> 31, etc.
 */
function androidVersionToApi(versionStr) {
    const mapping = {
        '4.4': 19, '5.0': 21, '5.1': 22, '6.0': 23, '7.0': 24, '7.1': 25,
        '8.0': 26, '8.1': 27, '9': 28, '9.0': 28, '10': 29, '11': 30,
        '12': 31, '12L': 32, '13': 33, '14': 34, '15': 35
    };
    
    // Try exact match first
    if (mapping[versionStr]) return mapping[versionStr];
    
    // Try parsing as number
    const num = parseFloat(versionStr);
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

/**
 * Try APKPure with device-specific version selection
 */
async function tryApkPureWithCompatibility(packageName, deviceInfo) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    try {
        // If we have device info, try to find a compatible version
        if (deviceInfo.apiLevel) {
            // Fetch APKPure app page to find version history
            const appPageUrl = `https://apkpure.com/search?q=${packageName}`;
            const searchResp = await axios.get(appPageUrl, { headers, timeout: 15000 });
            const $ = cheerio.load(searchResp.data);
            
            // Find the app link
            const appLink = $('a.first-info').first().attr('href');
            if (appLink) {
                const versionsUrl = appLink.endsWith('/') ? 
                    `https://apkpure.com${appLink}versions` : 
                    `https://apkpure.com${appLink}/versions`;
                
                console.log(`  Checking versions at: ${versionsUrl}`);
                
                try {
                    const versionsResp = await axios.get(versionsUrl, { headers, timeout: 15000 });
                    const $v = cheerio.load(versionsResp.data);
                    
                    // Look for versions and their requirements
                    // APKPure shows "Requires Android: X.X" for each version
                    const versions = [];
                    $v('.ver-item, .version-item, [class*="version"]').each((i, el) => {
                        const $el = $v(el);
                        const versionText = $el.find('.ver-info-top, .version-name, [class*="name"]').text();
                        const requiresText = $el.find('.ver-item-n, .requires, [class*="require"]').text();
                        const downloadLink = $el.find('a[href*="download"]').attr('href');
                        
                        if (versionText && downloadLink) {
                            // Parse "Requires Android: 5.0 and up" -> 21
                            const reqMatch = requiresText.match(/(\d+\.?\d*)/);
                            const minSdk = reqMatch ? androidVersionToApi(reqMatch[1]) : null;
                            
                            versions.push({
                                version: versionText.trim(),
                                minSdk: minSdk,
                                downloadUrl: downloadLink.startsWith('http') ? downloadLink : `https://apkpure.com${downloadLink}`
                            });
                        }
                    });
                    
                    // Find the newest compatible version
                    const compatibleVersion = versions.find(v => 
                        !v.minSdk || v.minSdk <= deviceInfo.apiLevel
                    );
                    
                    if (compatibleVersion) {
                        console.log(`  ✓ Found compatible version: ${compatibleVersion.version} (minSdk: ${compatibleVersion.minSdk || 'unknown'})`);
                        return {
                            success: true,
                            source: 'apkpure_compatible',
                            downloadUrl: compatibleVersion.downloadUrl,
                            packageName: packageName,
                            version: compatibleVersion.version,
                            minSdk: compatibleVersion.minSdk,
                            compatible: true,
                            deviceApiLevel: deviceInfo.apiLevel,
                            format: 'XAPK'
                        };
                    } else if (versions.length > 0) {
                        // All versions are incompatible
                        console.log(`  ✗ No compatible version found. Oldest requires API ${versions[versions.length-1]?.minSdk}`);
                        return {
                            success: false,
                            compatible: false,
                            error: `No compatible version available for Android ${getAndroidVersionName(deviceInfo.apiLevel)}`,
                            newestVersion: versions[0],
                            packageName: packageName
                        };
                    }
                } catch (versionError) {
                    console.log(`  Could not fetch version list: ${versionError.message}`);
                }
            }
        }
        
        // Fall through to basic method
        return { success: false };
        
    } catch (error) {
        console.log(`  APKPure compatibility check error: ${error.message}`);
        return { success: false };
    }
}

/**
 * Basic APKPure method (latest version, no compatibility check)
 */
async function tryApkPureBasic(packageName) {
    try {
        // Try XAPK format first
        const xapkUrl = `https://d.apkpure.com/b/XAPK/${packageName}?version=latest`;
        
        try {
            await axios.head(xapkUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 10000,
                maxRedirects: 5
            });
            console.log(`  ✓ APKPure XAPK works`);
            return {
                success: true,
                source: 'apkpure_direct',
                downloadUrl: xapkUrl,
                packageName: packageName,
                format: 'XAPK',
                note: 'Latest version - compatibility not verified'
            };
        } catch (e) {
            // Try APK format
            const apkUrl = `https://d.apkpure.com/b/APK/${packageName}?version=latest`;
            await axios.head(apkUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 10000
            });
            console.log(`  ✓ APKPure APK works`);
            return {
                success: true,
                source: 'apkpure_direct',
                downloadUrl: apkUrl,
                packageName: packageName,
                format: 'APK'
            };
        }
    } catch (error) {
        return { success: false };
    }
}

/**
 * Try APKMirror with device-specific variant selection
 */
async function tryApkMirrorWithCompatibility(packageName, deviceInfo) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };

        // Search for the app
        const searchUrl = `https://www.apkmirror.com/?post_type=app_release&searchtype=app&s=${packageName}`;
        const searchResp = await axios.get(searchUrl, { headers, timeout: 15000 });
        const $search = cheerio.load(searchResp.data);
        
        const appLink = $search('div.appRow h5.appRowTitle a').first().attr('href');
        
        if (!appLink) {
            console.log('  APKMirror: App not found');
            return { success: false };
        }

        const appUrl = `https://www.apkmirror.com${appLink}`;
        
        // If we have device info, try to find the right variant
        if (deviceInfo.apiLevel || deviceInfo.arch) {
            try {
                const appResp = await axios.get(appUrl, { headers, timeout: 15000 });
                const $app = cheerio.load(appResp.data);
                
                // Look for variant table
                const variants = [];
                $app('.variants-table .table-row, .listWidget .appRow').each((i, el) => {
                    const $el = $app(el);
                    const variantText = $el.text();
                    const link = $el.find('a').attr('href');
                    
                    // Parse architecture from variant text (arm64-v8a, armeabi-v7a, etc.)
                    const archMatch = variantText.match(/(arm64-v8a|armeabi-v7a|x86_64|x86|universal)/i);
                    const arch = archMatch ? archMatch[1].toLowerCase() : null;
                    
                    // Parse minSdk from "minAPI XX" or "Android X.X+"
                    const minApiMatch = variantText.match(/minAPI\s*(\d+)/i) || 
                                       variantText.match(/Android\s*(\d+\.?\d*)\+/i);
                    let minSdk = null;
                    if (minApiMatch) {
                        minSdk = minApiMatch[1].includes('.') ? 
                            androidVersionToApi(minApiMatch[1]) : 
                            parseInt(minApiMatch[1]);
                    }
                    
                    // Parse DPI
                    const dpiMatch = variantText.match(/(nodpi|mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi)/i);
                    const dpi = dpiMatch ? dpiMatch[1].toLowerCase() : null;
                    
                    if (link) {
                        variants.push({ arch, minSdk, dpi, link: `https://www.apkmirror.com${link}`, text: variantText.trim().substring(0, 100) });
                    }
                });
                
                // Score and sort variants by compatibility
                const scoredVariants = variants.map(v => {
                    let score = 0;
                    
                    // Architecture match
                    if (deviceInfo.arch) {
                        if (v.arch === deviceInfo.arch) score += 100;
                        else if (v.arch === 'universal' || v.arch === 'nodpi') score += 50;
                        else if (deviceInfo.arch === 'arm64-v8a' && v.arch === 'armeabi-v7a') score += 30; // Backwards compatible
                    }
                    
                    // API level compatibility
                    if (deviceInfo.apiLevel && v.minSdk) {
                        if (v.minSdk <= deviceInfo.apiLevel) score += 50;
                        else score -= 1000; // Incompatible
                    }
                    
                    // DPI match
                    if (deviceInfo.dpi && v.dpi) {
                        if (v.dpi === deviceInfo.dpi) score += 20;
                        else if (v.dpi === 'nodpi') score += 10;
                    }
                    
                    return { ...v, score };
                });
                
                scoredVariants.sort((a, b) => b.score - a.score);
                
                const bestVariant = scoredVariants.find(v => v.score > 0);
                
                if (bestVariant) {
                    console.log(`  ✓ APKMirror found compatible variant: ${bestVariant.text}`);
                    return {
                        success: true,
                        source: 'apkmirror',
                        downloadUrl: bestVariant.link,
                        packageName: packageName,
                        variant: {
                            arch: bestVariant.arch,
                            minSdk: bestVariant.minSdk,
                            dpi: bestVariant.dpi
                        },
                        compatible: true,
                        note: 'APKMirror - click download on the page'
                    };
                } else if (scoredVariants.length > 0 && scoredVariants.every(v => v.score < 0)) {
                    // All variants are incompatible
                    return {
                        success: false,
                        compatible: false,
                        error: `No compatible variant for API ${deviceInfo.apiLevel} / ${deviceInfo.arch}`,
                        availableVariants: scoredVariants.slice(0, 3).map(v => v.text)
                    };
                }
            } catch (variantError) {
                console.log(`  Could not parse variants: ${variantError.message}`);
            }
        }

        // Return the app page if we couldn't find specific variants
        console.log(`  ✓ APKMirror found: ${appUrl}`);
        return {
            success: true,
            source: 'apkmirror',
            downloadUrl: appUrl,
            packageName: packageName,
            note: 'APKMirror app page - select compatible version manually'
        };

    } catch (error) {
        console.log(`  APKMirror error: ${error.message}`);
        return { success: false };
    }
}

/**
 * APKCombo - Alternative source (basic, no version filtering yet)
 */
async function tryApkCombo(packageName) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };

        const appUrl = `https://apkcombo.com/app/${packageName}/`;
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

// ============================================================
// PROXY DOWNLOAD ENDPOINT
// ============================================================

app.get('/download-apk/:packageName', async (req, res) => {
    const packageName = req.params.packageName;
    const deviceInfo = getDeviceInfo(req);
    
    try {
        // If device info provided, check compatibility first
        if (deviceInfo.apiLevel) {
            const apkInfo = await tryApkPureWithCompatibility(packageName, deviceInfo);
            if (apkInfo.compatible === false) {
                return res.status(400).json({
                    error: 'Incompatible app',
                    message: apkInfo.error || `This app is not compatible with Android API ${deviceInfo.apiLevel}`,
                    deviceApiLevel: deviceInfo.apiLevel,
                    deviceAndroidVersion: getAndroidVersionName(deviceInfo.apiLevel)
                });
            }
        }
        
        // Try XAPK first
        const downloadUrl = `https://d.apkpure.com/b/XAPK/${packageName}?version=latest`;
        
        console.log(`Proxying download: ${downloadUrl}`);
        
        const response = await axios({
            method: 'GET',
            url: downloadUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*'
            },
            timeout: 300000,
            maxRedirects: 10
        });

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${packageName}.xapk"`);
        
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }
        
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
            const response = await axios({
                method: 'GET',
                url: apkUrl,
                responseType: 'stream',
                headers: { 'User-Agent': 'Mozilla/5.0' },
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

// ============================================================
// SEARCH WITH APK URLs - Now includes compatibility
// ============================================================

app.get('/search-with-apk/:query', async (req, res) => {
    const deviceInfo = getDeviceInfo(req);
    
    try {
        const results = await gplay.search({
            term: req.params.query,
            num: 15
        });
        
        const appsWithApk = results.map(app => {
            let packageName = app.appId;
            if (!packageName && app.url) {
                const match = app.url.match(/id=([^&]+)/);
                if (match) packageName = match[1];
            }
            
            // Build APK URLs with device info
            const queryString = deviceInfo.apiLevel ? 
                `?apiLevel=${deviceInfo.apiLevel}${deviceInfo.arch ? `&arch=${deviceInfo.arch}` : ''}` : '';
            
            return {
                name: app.title,
                packageName: packageName || null,
                developer: app.developer,
                icon: app.icon,
                rating: app.score,
                installs: app.installs,
                free: app.free,
                androidVersion: app.androidVersion,
                apkUrls: packageName ? {
                    apkpure: `https://d.apkpure.com/b/XAPK/${packageName}?version=latest`,
                    apkpureApk: `https://d.apkpure.com/b/APK/${packageName}?version=latest`,
                    proxy: `https://kosher-store-backend.onrender.com/download-apk/${packageName}${queryString}`,
                    compatible: `https://kosher-store-backend.onrender.com/apk-url/${packageName}${queryString}`
                } : null
            };
        });
        
        res.json({ 
            success: true, 
            results: appsWithApk,
            deviceInfo: deviceInfo.apiLevel ? {
                apiLevel: deviceInfo.apiLevel,
                arch: deviceInfo.arch,
                androidVersion: getAndroidVersionName(deviceInfo.apiLevel)
            } : undefined
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// NEW: Check compatibility endpoint
// ============================================================

app.get('/check-compatibility/:packageName', async (req, res) => {
    const packageName = req.params.packageName;
    const deviceInfo = getDeviceInfo(req);
    
    if (!deviceInfo.apiLevel) {
        return res.status(400).json({
            error: 'Missing apiLevel parameter',
            usage: '/check-compatibility/com.example.app?apiLevel=30&arch=arm64-v8a'
        });
    }
    
    try {
        // Get app info from Play Store
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
                androidVersion: getAndroidVersionName(deviceInfo.apiLevel),
                arch: deviceInfo.arch
            },
            message: compatible ? 
                'This app is compatible with your device' :
                `This app requires Android ${appData.androidVersion} (API ${minSdk}). Your device runs API ${deviceInfo.apiLevel}.`
        });
        
    } catch (error) {
        res.json({ 
            success: false, 
            error: error.message,
            packageName: packageName 
        });
    }
});

app.listen(PORT, () => {
    console.log(`Kosher Store Backend v4.0 running on port ${PORT}`);
    console.log('New features: Device-aware APK filtering, compatibility checks');
});
