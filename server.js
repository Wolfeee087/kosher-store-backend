const express = require('express');
const cors = require('cors');
const gplay = require('google-play-scraper');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'Kosher Store Backend Running',
        version: '1.0.0',
        endpoints: ['/app/:packageName', '/search/:query', '/download/:packageName']
    });
});

// Get app details from Play Store
app.get('/app/:packageName', async (req, res) => {
    try {
        const { packageName } = req.params;
        const app = await gplay.app({ appId: packageName });
        
        res.json({
            success: true,
            app: {
                name: app.title,
                packageName: app.appId,
                description: app.summary,
                fullDescription: app.description,
                icon: app.icon,
                developer: app.developer,
                version: app.version,
                size: app.size,
                installs: app.installs,
                rating: app.score,
                category: app.genre,
                updated: app.updated,
                androidVersion: app.androidVersion,
                screenshots: app.screenshots
            }
        });
    } catch (error) {
        res.status(404).json({ 
            success: false, 
            error: 'App not found: ' + error.message 
        });
    }
});

// Search apps on Play Store
app.get('/search/:query', async (req, res) => {
    try {
        const { query } = req.params;
        const limit = parseInt(req.query.limit) || 10;
        
        const results = await gplay.search({
            term: query,
            num: limit
        });
        
        res.json({
            success: true,
            results: results.map(app => ({
                name: app.title,
                packageName: app.appId,
                description: app.summary,
                icon: app.icon,
                developer: app.developer,
                rating: app.score,
                installs: app.installs,
                free: app.free
            }))
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Search failed: ' + error.message 
        });
    }
});

// Get APK download URL using APKPure API
app.get('/download/:packageName', async (req, res) => {
    try {
        const { packageName } = req.params;
        
        // First get app info
        const appInfo = await gplay.app({ appId: packageName });
        
        // Generate APKPure download page URL
        const apkpureUrl = `https://apkpure.com/search?q=${packageName}`;
        
        // APKMirror URL
        const apkmirrorUrl = `https://www.apkmirror.com/?s=${packageName}`;
        
        // Direct APK download services
        const downloadOptions = {
            apkpure: `https://d.apkpure.com/b/APK/${packageName}?version=latest`,
            apkcombo: `https://apkcombo.com/downloader/#package=${packageName}`,
            evozi: `https://apps.evozi.com/apk-downloader/?id=${packageName}`
        };
        
        res.json({
            success: true,
            app: {
                name: appInfo.title,
                packageName: appInfo.appId,
                version: appInfo.version,
                size: appInfo.size,
                icon: appInfo.icon
            },
            downloadUrls: downloadOptions,
            note: 'Use APKPure or APKMirror to download the APK manually, then host it on your server'
        });
    } catch (error) {
        res.status(404).json({ 
            success: false, 
            error: 'App not found: ' + error.message 
        });
    }
});

// Proxy endpoint to fetch APK from hosted URL
app.get('/fetch-apk', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) {
            return res.status(400).json({ success: false, error: 'URL required' });
        }
        
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream'
        });
        
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', 'attachment; filename="app.apk"');
        response.data.pipe(res);
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch APK: ' + error.message 
        });
    }
});

// List of pre-approved safe apps with direct download links
app.get('/approved-apps', (req, res) => {
    const approvedApps = [
        {
            id: 'khan_academy',
            name: 'Khan Academy',
            packageName: 'org.khanacademy.android',
            category: 'Education',
            description: 'Free educational videos and exercises',
            icon: 'https://play-lh.googleusercontent.com/B5coOyg-WmTDE4EvJcVqT2X0xqXT7JnTCnW5xgXAaIoBfwLk5ZDQPpGPbD1T0aJhdA=w240-h480-rw'
        },
        {
            id: 'duolingo',
            name: 'Duolingo',
            packageName: 'com.duolingo',
            category: 'Education',
            description: 'Learn languages for free',
            icon: 'https://play-lh.googleusercontent.com/6A3dEYrOCfXVhEw8bLqe-ampUE3HMWLYX3P9LS1F1UYwH3dLZsowTI6fhPyXPdByhA=w240-h480-rw'
        },
        {
            id: 'google_docs',
            name: 'Google Docs',
            packageName: 'com.google.android.apps.docs.editors.docs',
            category: 'Productivity',
            description: 'Create and edit documents',
            icon: 'https://play-lh.googleusercontent.com/emmbClh_hm0WpWZqJ0X59B8Pz1mKoB9HVLkYMktxhGE6WRL4JqsHVE-7S04E8WZBASA=w240-h480-rw'
        }
    ];
    
    res.json({
        success: true,
        apps: approvedApps
    });
});

app.listen(PORT, () => {
    console.log(`Kosher Store Backend running on port ${PORT}`);
});
