/**
 * Kosher Store Backend v6.0 - Simplified
 * 
 * The app now handles APK URL resolution directly via Firebase.
 * This backend is only needed for:
 * 1. App search (Google Play scraper) - for Kosher Store browse/search
 * 2. URL verification - for dashboard when adding overrides
 * 3. Logging - optional, for admin visibility
 * 
 * NO MORE:
 * - APK URL resolution (app does this directly)
 * - Backend wake detection (not needed anymore)
 * - Cold start delays affecting users
 */

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
// FIREBASE ADMIN INITIALIZATION (for logging only)
// ============================================================

let firebaseInitialized = false;

function initFirebase() {
    if (firebaseInitialized) return;
    
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://yeshiva-filter-default-rtdb.firebaseio.com'
            });
            firebaseInitialized = true;
            console.log('✅ Firebase Admin initialized');
        } else {
            console.log('⚠️ Firebase not configured - logging disabled');
        }
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
        version: '6.0.0',
        description: 'Simplified backend - app handles APK resolution directly via Firebase',
        features: [
            'App search (Google Play scraper)',
            'URL verification for dashboard',
            'Override logging'
        ],
        note: 'APK URL resolution is now handled by the app directly - no cold start delays!',
        firebaseConnected: firebaseInitialized,
        endpoints: [
            'GET /search/:query - Search Google Play',
            'GET /app/:packageName - Get app info',
            'POST /override/verify - Verify APK URL',
            'POST /override/log - Log install result',
            'GET /overrides - List all overrides (from Firebase)'
        ]
    });
});

// ============================================================
// PING ENDPOINT (for uptime monitoring)
// ============================================================

app.get('/ping', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// ============================================================
// APP SEARCH (for Kosher Store browse/search)
// ============================================================

app.get('/search/:query', async (req, res) => {
    try {
        const results = await gplay.search({ 
            term: req.params.query, 
            num: 30,
            fullDetail: false
        });
        
        // Process results and fix missing package names
        const processedResults = await Promise.all(
            results.map(async (a, index) => {
                // If package name is missing, try to get it from the URL or fetch details
                let packageName = a.appId;
                
                // Method 1: Extract from URL
                if (!packageName && a.url) {
                    const match = a.url.match(/[?&]id=([^&]+)/);
                    if (match) {
                        packageName = match[1];
                    }
                }
                
                // Method 2: For first 5 results without package, fetch full details
                if (!packageName && index < 5 && a.title) {
                    try {
                        // Search for this specific app by name
                        const detailed = await gplay.search({
                            term: a.title,
                            num: 1,
                            fullDetail: true
                        });
                        if (detailed[0] && detailed[0].appId) {
                            packageName = detailed[0].appId;
                        }
                    } catch (e) {
                        console.log(`Could not fetch details for: ${a.title}`);
                    }
                }
                
                return {
                    name: a.title,
                    packageName: packageName || null,
                    developer: a.developer,
                    icon: a.icon,
                    rating: a.score,
                    installs: a.installs,
                    free: a.free,
                    summary: a.summary,
                    url: a.url || null
                };
            })
        );
        
        // Sort: apps with package names first
        const withPackage = processedResults.filter(r => r.packageName);
        const withoutPackage = processedResults.filter(r => !r.packageName);
        
        res.json({ 
            success: true, 
            count: processedResults.length,
            results: [...withPackage, ...withoutPackage]
        });
    } catch (error) {
        console.error('Search error:', error.message);
        res.json({ success: false, error: error.message, results: [] });
    }
});

// ============================================================
// SEARCH WITH FULL DETAILS (slower but complete)
// ============================================================

app.get('/search-full/:query', async (req, res) => {
    try {
        const results = await gplay.search({ 
            term: req.params.query, 
            num: 15,  // Fewer results since we fetch full details
            fullDetail: true  // Get complete info including package name
        });
        
        res.json({ 
            success: true, 
            count: results.length,
            results: results.map(a => ({
                name: a.title,
                packageName: a.appId,
                developer: a.developer,
                icon: a.icon,
                rating: a.score,
                installs: a.installs,
                free: a.free,
                summary: a.summary,
                version: a.version,
                androidVersion: a.androidVersionText
            }))
        });
    } catch (error) {
        console.error('Search error:', error.message);
        res.json({ success: false, error: error.message, results: [] });
    }
});

// ============================================================
// LOOKUP PACKAGE NAME BY TITLE (for Add Manually button)
// ============================================================

app.get('/lookup/:title', async (req, res) => {
    try {
        const title = decodeURIComponent(req.params.title);
        console.log(`Looking up package name for: "${title}"`);
        
        // Search with full details to get package name
        const results = await gplay.search({
            term: title,
            num: 5,
            fullDetail: true
        });
        
        if (results.length === 0) {
            return res.json({ success: false, error: 'App not found' });
        }
        
        // Find best match by title
        const exactMatch = results.find(r => 
            r.title.toLowerCase() === title.toLowerCase()
        );
        
        const match = exactMatch || results[0];
        
        res.json({
            success: true,
            app: {
                name: match.title,
                packageName: match.appId,
                developer: match.developer,
                icon: match.icon,
                rating: match.score,
                installs: match.installs
            }
        });
    } catch (error) {
        console.error('Lookup error:', error.message);
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// APP INFO (for Kosher Store app details)
// ============================================================

app.get('/app/:packageName', async (req, res) => {
    try {
        const appData = await gplay.app({ appId: req.params.packageName });
        res.json({ 
            success: true, 
            app: {
                name: appData.title,
                packageName: appData.appId,
                developer: appData.developer,
                icon: appData.icon,
                rating: appData.score,
                installs: appData.installs,
                free: appData.free,
                summary: appData.summary,
                description: appData.description,
                version: appData.version,
                androidVersion: appData.androidVersion,
                androidVersionText: appData.androidVersionText,
                updated: appData.updated,
                genre: appData.genre,
                screenshots: appData.screenshots?.slice(0, 5) || []
            }
        });
    } catch (error) {
        console.error('App info error:', error.message);
        res.json({ success: false, error: error.message });
    }
});

// ============================================================
// CATEGORY BROWSE (for Kosher Store categories)
// ============================================================

app.get('/category/:category', async (req, res) => {
    try {
        const results = await gplay.list({
            category: req.params.category.toUpperCase(),
            collection: gplay.collection.TOP_FREE,
            num: 50
        });
        
        res.json({ 
            success: true,
            category: req.params.category,
            count: results.length,
            results: results.map(a => ({
                name: a.title,
                packageName: a.appId,
                developer: a.developer,
                icon: a.icon,
                rating: a.score,
                installs: a.installs
            }))
        });
    } catch (error) {
        res.json({ success: false, error: error.message, results: [] });
    }
});

// ============================================================
// URL VERIFICATION (for dashboard when adding overrides)
// ============================================================

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
                           contentType.includes('application/vnd') ||
                           contentType.includes('application/zip');
        
        const warnings = [];
        if (!isValidSize) warnings.push(`File size (${Math.round(contentLength/1024)}KB) seems too small for an APK`);
        if (!isValidType && contentLength > 0) warnings.push(`Content-Type "${contentType}" may not be an APK`);
        
        res.json({
            success: true,
            valid: isValidSize,
            contentLength,
            contentLengthMB: (contentLength / 1024 / 1024).toFixed(2),
            contentType,
            warnings,
            headers: {
                'accept-ranges': response.headers['accept-ranges'] || 'none',
                'content-disposition': response.headers['content-disposition'] || null
            }
        });
        
    } catch (error) {
        res.json({
            success: false,
            error: error.message,
            warnings: ['URL is not accessible or returned an error']
        });
    }
});

// ============================================================
// LOGGING (for admin visibility of installs)
// ============================================================

app.post('/override/log', async (req, res) => {
    if (!firebaseInitialized) {
        return res.json({ success: true, note: 'Logging disabled - Firebase not configured' });
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
            source: 'backend',
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

// ============================================================
// LIST OVERRIDES (for dashboard)
// ============================================================

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
        
        res.json({ success: true, count: overrides.length, overrides });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ============================================================
// OVERRIDE LOGS (for dashboard)
// ============================================================

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
// LEGACY ENDPOINT (for old app versions)
// Returns APKPure URL directly - no processing needed
// ============================================================

app.get('/apk-url/:packageName', async (req, res) => {
    const packageName = req.params.packageName;
    
    console.log(`[LEGACY] APK URL request for ${packageName} - app should handle this directly now`);
    
    // Just return APKPure URL directly - app should be doing this itself
    let appName = packageName;
    try {
        const appInfo = await gplay.app({ appId: packageName });
        appName = appInfo.title || packageName;
    } catch (e) {}
    
    // Try XAPK first
    const xapkUrl = `https://d.apkpure.com/b/XAPK/${packageName}?version=latest`;
    try {
        await axios.head(xapkUrl, { 
            headers: { 'User-Agent': 'Mozilla/5.0' }, 
            timeout: 10000 
        });
        return res.json({
            success: true,
            compatible: true,
            source: 'apkpure',
            downloadUrl: xapkUrl,
            packageName,
            appName,
            format: 'XAPK',
            version: 'latest',
            note: 'Please update app - new version handles this directly without backend'
        });
    } catch (e) {}
    
    // Try APK
    const apkUrl = `https://d.apkpure.com/b/APK/${packageName}?version=latest`;
    try {
        await axios.head(apkUrl, { 
            headers: { 'User-Agent': 'Mozilla/5.0' }, 
            timeout: 10000 
        });
        return res.json({
            success: true,
            compatible: true,
            source: 'apkpure',
            downloadUrl: apkUrl,
            packageName,
            appName,
            format: 'APK',
            version: 'latest',
            note: 'Please update app - new version handles this directly without backend'
        });
    } catch (e) {}
    
    res.json({ success: false, error: 'APK not found on APKPure' });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
    console.log(`\n🚀 Kosher Store Backend v6.0 (Simplified) running on port ${PORT}`);
    console.log(`📱 Firebase: ${firebaseInitialized ? 'Connected' : 'Not configured'}`);
    console.log(`\n📝 Note: APK resolution now handled by app directly`);
    console.log(`   This backend is only for search, verification, and logging\n`);
});
