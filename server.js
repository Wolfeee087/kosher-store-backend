const express = require('express');
const cors = require('cors');
const gplay = require('google-play-scraper');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ============================================================
// FIREBASE ADMIN INITIALIZATION
// ============================================================

let firebaseInitialized = false;

function initFirebase() {
    if (firebaseInitialized) return;
    
    try {
        // Initialize with environment variable or service account
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://yeshiva-filter-default-rtdb.firebaseio.com'
            });
        } else if (process.env.FIREBASE_DATABASE_URL) {
            // For environments where default credentials work
            admin.initializeApp({
                databaseURL: process.env.FIREBASE_DATABASE_URL
            });
        } else {
            console.log('⚠️ Firebase not configured - override system disabled');
            return;
        }
        firebaseInitialized = true;
        console.log('✅ Firebase Admin initialized');
    } catch (e) {
        console.log('⚠️ Firebase init failed:', e.message);
    }
}

initFirebase();

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/', (req, res) => {
    res.json({
        status: 'Kosher Store Backend Running',
        version: '5.0.0',
        features: [
            'Manual APK override system (Firebase-based)',
            'Device-aware APK filtering',
            'Override logging and statistics',
            'Fallback to APKPure for non-overridden apps'
        ],
        firebaseConnected: firebaseInitialized,
        endpoints: [
            'GET /apk-url/:packageName?apiLevel=30&model=F21&manufacturer=DuoQin',
            'GET /overrides - List all overrides',
            'POST /override/verify - Verify an APK URL',
            'POST /override/log - Log install result'
        ]
    });
});

// ============================================================
// HELPERS
// ============================================================

function getDeviceInfo(req) {
    return {
        apiLevel: parseInt(req.query.apiLevel) || null,
        arch: req.query.arch || null,
        model: req.query.model || null,
        manufacturer: req.query.manufacturer || null,
        deviceId: req.query.deviceId || null,
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

// ============================================================
// MAIN APK URL ENDPOINT
// ============================================================

app.get('/apk-url/:packageName', async (req, res) => {
    const packageName = req.params.packageName;
    const deviceInfo = getDeviceInfo(req);
    
    console.log(`\n=== APK Request: ${packageName} ===`);
    console.log(`Device: ${deviceInfo.manufacturer || '?'} ${deviceInfo.model || '?'}, API ${deviceInfo.apiLevel}`);
    
    try {
        // ============================================================
        // STEP 1: Check for manual override in Firebase (if configured)
        // Only returns if there's a MATCHING override for this device
        // Otherwise falls through to normal APKPure search
        // ============================================================
        if (firebaseInitialized) {
            const override = await findMatchingOverride(packageName, deviceInfo);
            
            if (override) {
                console.log(`✅ Override matched: ${override.appName} v${override.override.version}`);
                console.log(`   Target: API ${override.targeting?.minApiLevel || '*'}-${override.targeting?.maxApiLevel || '*'}, Models: ${override.targeting?.deviceModels?.join(',') || '*'}`);
                
                // Log the usage
                await logOverrideUsage(override.id, packageName, deviceInfo, 'override_matched');
                
                // Increment install count
                await incrementOverrideCount(override.id);
                
                return res.json({
                    success: true,
                    compatible: true,
                    source: 'manual_override',
                    downloadUrl: override.override.downloadUrl,
                    packageName: packageName,
                    appName: override.appName,
                    version: override.override.version,
                    format: override.override.format || 'APK',
                    isOverride: true,
                    overrideId: override.id,
                    overrideNotes: override.metadata?.notes,
                    expectedSize: override.override.fileSizeBytes || null,
                    expectedHash: override.override.sha256Hash || null
                });
            } else {
                console.log(`→ No override for this device, using APKPure...`);
            }
        }
        
        // ============================================================
        // STEP 2: No override matched - Use APKPure (normal flow)
        // ============================================================
        let appName = packageName;
        
        try {
            const appInfo = await gplay.app({ appId: packageName });
            appName = appInfo.title || packageName;
        } catch (e) {}
        
        console.log(`→ No override, trying latest version...`);
        
        // Try APKPure XAPK first
        const xapkUrl = `https://d.apkpure.com/b/XAPK/${packageName}?version=latest`;
        try {
            await axios.head(xapkUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 10000
            });
            console.log('✓ APKPure XAPK available');
            return res.json({
                success: true,
                compatible: true,
                source: 'apkpure',
                downloadUrl: xapkUrl,
                packageName: packageName,
                appName: appName,
                format: 'XAPK',
                version: 'latest',
                isOverride: false
            });
        } catch (e) {}
        
        // Try APKPure APK
        const apkUrl = `https://d.apkpure.com/b/APK/${packageName}?version=latest`;
        try {
            await axios.head(apkUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
            console.log('✓ APKPure APK available');
            return res.json({
                success: true,
                compatible: true,
                source: 'apkpure',
                downloadUrl: apkUrl,
                packageName: packageName,
                appName: appName,
                format: 'APK',
                version: 'latest',
                isOverride: false
            });
        } catch (e) {}

        // No source found
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
// FIND MATCHING OVERRIDE
// ============================================================

async function findMatchingOverride(packageName, deviceInfo) {
    if (!firebaseInitialized) return null;
    
    try {
        const db = admin.database();
        const snapshot = await db.ref('apk_overrides')
            .orderByChild('packageName')
            .equalTo(packageName)
            .once('value');
        
        if (!snapshot.exists()) return null;
        
        const overrides = [];
        snapshot.forEach(child => {
            const data = child.val();
            data.id = child.key;
            overrides.push(data);
        });
        
        // Sort by specificity (more specific = higher priority)
        overrides.sort((a, b) => {
            return getSpecificityScore(b.targeting) - getSpecificityScore(a.targeting);
        });
        
        // Find first matching override
        for (const override of overrides) {
            // Skip disabled overrides
            if (override.status?.enabled === false) continue;
            
            // Check expiration
            if (override.expiration?.expiresAt) {
                if (Date.now() > override.expiration.expiresAt) continue;
            }
            
            // Check if targeting matches
            if (matchesTargeting(override.targeting, deviceInfo)) {
                return override;
            }
        }
        
        return null;
        
    } catch (e) {
        console.error('Override lookup error:', e.message);
        return null;
    }
}

function getSpecificityScore(targeting) {
    if (!targeting) return 0;
    let score = 0;
    if (targeting.deviceModels?.length > 0) score += 100;
    if (targeting.manufacturers?.length > 0) score += 50;
    if (targeting.minApiLevel || targeting.maxApiLevel) score += 10;
    return score;
}

function matchesTargeting(targeting, deviceInfo) {
    if (!targeting) return true; // No targeting = matches all
    
    // Check API level range
    if (targeting.minApiLevel && deviceInfo.apiLevel) {
        if (deviceInfo.apiLevel < targeting.minApiLevel) return false;
    }
    if (targeting.maxApiLevel && deviceInfo.apiLevel) {
        if (deviceInfo.apiLevel > targeting.maxApiLevel) return false;
    }
    
    // Check device model (if specified)
    if (targeting.deviceModels?.length > 0 && deviceInfo.model) {
        const modelMatch = targeting.deviceModels.some(model =>
            deviceInfo.model.toLowerCase().includes(model.toLowerCase()) ||
            model.toLowerCase().includes(deviceInfo.model.toLowerCase())
        );
        if (!modelMatch) return false;
    }
    
    // Check manufacturer (if specified)
    if (targeting.manufacturers?.length > 0 && deviceInfo.manufacturer) {
        const mfgMatch = targeting.manufacturers.some(mfg =>
            deviceInfo.manufacturer.toLowerCase().includes(mfg.toLowerCase()) ||
            mfg.toLowerCase().includes(deviceInfo.manufacturer.toLowerCase())
        );
        if (!mfgMatch) return false;
    }
    
    return true;
}

// ============================================================
// LOGGING
// ============================================================

async function logOverrideUsage(overrideId, packageName, deviceInfo, action, extra = {}) {
    if (!firebaseInitialized) return;
    
    try {
        await admin.database().ref('apk_override_logs').push({
            overrideId,
            packageName,
            deviceId: deviceInfo.deviceId || 'unknown',
            deviceModel: deviceInfo.model || 'unknown',
            deviceManufacturer: deviceInfo.manufacturer || 'unknown',
            deviceApiLevel: deviceInfo.apiLevel || 0,
            action,
            timestamp: admin.database.ServerValue.TIMESTAMP,
            ...extra
        });
    } catch (e) {
        console.error('Log error:', e.message);
    }
}

async function incrementOverrideCount(overrideId) {
    if (!firebaseInitialized) return;
    
    try {
        const ref = admin.database().ref(`apk_overrides/${overrideId}/status`);
        await ref.update({
            installCount: admin.database.ServerValue.increment(1),
            lastInstalledAt: admin.database.ServerValue.TIMESTAMP
        });
    } catch (e) {
        console.error('Increment error:', e.message);
    }
}

// ============================================================
// API ENDPOINTS FOR DASHBOARD
// ============================================================

// List all overrides
app.get('/overrides', async (req, res) => {
    if (!firebaseInitialized) {
        return res.json({ success: false, error: 'Firebase not configured' });
    }
    
    try {
        const snapshot = await admin.database().ref('apk_overrides').once('value');
        const overrides = [];
        
        snapshot.forEach(child => {
            overrides.push({ id: child.key, ...child.val() });
        });
        
        res.json({ success: true, overrides });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// Verify an APK URL
app.post('/override/verify', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.json({ success: false, error: 'URL required' });
    }
    
    try {
        const response = await axios.head(url, {
            timeout: 15000,
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
                'Accept': '*/*'
            },
            maxRedirects: 5
        });
        
        const contentLength = parseInt(response.headers['content-length'] || '0');
        const contentType = response.headers['content-type'] || '';
        
        const isValidSize = contentLength > 1000000; // > 1MB
        const isValidType = contentType.includes('octet-stream') || 
                           contentType.includes('android') ||
                           contentType.includes('application/vnd');
        
        const warnings = [];
        if (!isValidSize) warnings.push(`File size (${Math.round(contentLength/1024)}KB) seems too small for an APK`);
        if (!isValidType) warnings.push(`Content-Type "${contentType}" may not be an APK`);
        
        res.json({
            success: true,
            valid: isValidSize,
            contentLength,
            contentLengthMB: (contentLength / 1024 / 1024).toFixed(2),
            contentType,
            warnings
        });
        
    } catch (error) {
        res.json({
            success: false,
            error: error.message,
            warnings: ['URL is not accessible or returned an error']
        });
    }
});

// Log install result from phone
app.post('/override/log', async (req, res) => {
    if (!firebaseInitialized) {
        return res.json({ success: false, error: 'Firebase not configured' });
    }
    
    const { overrideId, packageName, deviceId, action, error, extra } = req.body;
    
    try {
        await admin.database().ref('apk_override_logs').push({
            overrideId: overrideId || null,
            packageName: packageName || 'unknown',
            deviceId: deviceId || 'unknown',
            action: action || 'unknown',
            error: error || null,
            timestamp: admin.database.ServerValue.TIMESTAMP,
            ...(extra || {})
        });
        
        // Update failure count if install failed
        if (action === 'install_failed' && overrideId) {
            await admin.database().ref(`apk_overrides/${overrideId}/status/failureCount`)
                .set(admin.database.ServerValue.increment(1));
        }
        
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// Get override logs
app.get('/override/:id/logs', async (req, res) => {
    if (!firebaseInitialized) {
        return res.json({ success: false, error: 'Firebase not configured' });
    }
    
    try {
        const snapshot = await admin.database().ref('apk_override_logs')
            .orderByChild('overrideId')
            .equalTo(req.params.id)
            .limitToLast(100)
            .once('value');
        
        const logs = [];
        snapshot.forEach(child => {
            logs.push({ id: child.key, ...child.val() });
        });
        
        res.json({ success: true, logs: logs.reverse() });
    } catch (e) {
        res.json({ success: false, error: e.message });
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
            name: a.title, 
            packageName: a.appId, 
            developer: a.developer,
            icon: a.icon, 
            rating: a.score, 
            installs: a.installs,
            androidVersion: a.androidVersion
        }))});
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
    console.log(`\n🚀 Kosher Store Backend v5.0 running on port ${PORT}`);
    console.log(`📱 Firebase: ${firebaseInitialized ? 'Connected' : 'Not configured'}`);
    console.log(`\nEndpoints:`);
    console.log(`  GET  /apk-url/:pkg?apiLevel=30&model=F21&manufacturer=DuoQin`);
    console.log(`  GET  /overrides`);
    console.log(`  POST /override/verify`);
    console.log(`  POST /override/log`);
});
