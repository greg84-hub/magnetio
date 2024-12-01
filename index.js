import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import AsyncLock from 'async-lock';
import { getDebridServices } from './src/debrids.js';
import { isVideo, base64Encode, base64Decode, extractInfoHash } from './src/util.js';
import { ERROR } from './src/const.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const lock = new AsyncLock();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.use(express.static(path.join(__dirname, 'public')));
app.options('*', cors());

// Configuration page endpoint
app.get('/configure', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Root manifest endpoint
app.get('/manifest.json', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const manifest = {
        id: 'org.Magnetio',
        version: '1.0.0',
        name: 'Magnetio',
        description: 'Stream movies via Debrid services - Configuration Required',
        resources: [],
        types: [],
        catalogs: [],
        behaviorHints: {
            configurable: true,
            configurationRequired: true,
            configurationURL: `${baseUrl}/configure`
        }
    };
    res.json(manifest);
});

async function getCinemetaMetadata(imdbId) {
    try {
        console.log(`\n🎬 Fetching Cinemeta data for ${imdbId}`);
        const response = await fetch(`https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`);
        if (!response.ok) throw new Error('Failed to fetch from Cinemeta');
        const data = await response.json();
        console.log('✅ Found:', data.meta.name);
        return data;
    } catch (error) {
        console.error('❌ Cinemeta error:', error);
        return null;
    }
}

async function readMovieData(imdbId, year) {
    const lockKey = `year-${year}`;
    const yearFile = path.join(__dirname, 'movies', `${year}.json`);

    try {
        return await lock.acquire(lockKey, async () => {
            console.log(`\n📂 Reading data for year ${year}`);
            const content = await fs.readFile(yearFile, 'utf8');
            const movies = JSON.parse(content);
            const movie = movies.find(m => m.imdbId === imdbId);
            if (movie) {
                console.log(`✅ Found movie: ${movie.originalTitle}`);
                console.log(`Found ${movie.streams.length} streams`);
            }
            return movie;
        });
    } catch (error) {
        if (error.name === 'AsyncLockTimeout') {
            console.error(`❌ Lock timeout reading year ${year}`);
            return null;
        }
        if (error.code !== 'ENOENT') {
            console.error(`❌ Error reading movie data:`, error);
        }
        return null;
    }
}

async function getTorrentioStreams(imdbId) {
    try {
        console.log('\n🔄 Fetching Torrentio streams');
        const torrentioUrl = `https://torrentio.strem.fun/stream/movie/${imdbId}.json`;
        const response = await fetch(torrentioUrl);
        if (!response.ok) return [];
        
        const data = await response.json();
        if (!data?.streams?.length) return [];

        console.log(`Processing ${data.streams.length} Torrentio streams`);
        return data.streams.map(stream => {
            try {
                if (!stream?.infoHash) return null;

                const quality = stream.name?.match(/\d{3,4}p|4k|HDTS|CAM/i)?.[0] || 
                              stream.title?.match(/\d{3,4}p|4k|HDTS|CAM/i)?.[0] || '';
                
                const size = stream.title?.match(/💾\s*([\d.]+)\s*(GB|MB)/i)?.[0] || '';

                const filename = stream.title?.split('\n')[0].trim() || 'Unknown';
                
                const magnetLink = `magnet:?xt=urn:btih:${stream.infoHash}`;
                
                return {
                    magnetLink,
                    filename,
                    websiteTitle: stream.title || filename,
                    quality,
                    size
                };
            } catch (error) {
                console.error('Error processing stream:', error);
                return null;
            }
        }).filter(Boolean);
    } catch (error) {
        console.error('❌ Error fetching Torrentio streams:', error);
        return [];
    }
}
async function checkCacheStatuses(service, hashes) {
    if (!hashes?.length) return {};

    try {
        const results = await service.checkCacheStatuses(hashes);
        return results;
    } catch (error) {
        console.error('Cache check error:', error);
        return {};
    }
}

async function mergeAndSaveStreams(existingStreams = [], newStreams = [], imdbId, year, movieTitle = '') {
    const lockKey = `year-${year}`;
    
    try {
        return await lock.acquire(lockKey, async () => {
            if (!newStreams.length) return existingStreams;

            const existingHashes = new Set(
                existingStreams.map(stream => 
                    stream.magnetLink.match(/btih:([^&]+)/i)?.[1]?.toLowerCase()
                ).filter(Boolean)
            );

            const uniqueNewStreams = newStreams.filter(stream => {
                const hash = stream.magnetLink.match(/btih:([^&]+)/i)?.[1]?.toLowerCase();
                return hash && !existingHashes.has(hash);
            });

            if (!uniqueNewStreams.length) return existingStreams;

            console.log(`Found ${uniqueNewStreams.length} new unique streams`);

            const mergedStreams = [...existingStreams, ...uniqueNewStreams];
            const yearFile = path.join(__dirname, 'movies', `${year}.json`);
            
            let movies = [];
            try {
                const content = await fs.readFile(yearFile, 'utf8');
                movies = JSON.parse(content);
            } catch (error) {
                console.log(`Creating new ${year}.json file`);
            }
            
            const movieIndex = movies.findIndex(m => m.imdbId === imdbId);
            if (movieIndex >= 0) {
                movies[movieIndex].streams = mergedStreams;
                movies[movieIndex].lastUpdated = new Date().toISOString();
            } else {
                movies.push({
                    imdbId,
                    streams: mergedStreams,
                    originalTitle: movieTitle,
                    addedAt: new Date().toISOString(),
                    lastUpdated: new Date().toISOString()
                });
            }
            
            await fs.mkdir(path.join(__dirname, 'movies'), { recursive: true });
            
            const tempFile = `${yearFile}.tmp`;
            await fs.writeFile(tempFile, JSON.stringify(movies, null, 2));
            await fs.rename(tempFile, yearFile);
            
            console.log(`✅ Added ${uniqueNewStreams.length} new streams to ${year}.json`);
            return mergedStreams;
        });
    } catch (error) {
        if (error.name === 'AsyncLockTimeout') {
            console.error(`❌ Lock timeout for year ${year}, skipping save`);
            return existingStreams;
        }
        console.error('❌ Error merging and saving streams:', error);
        return existingStreams;
    }
}

// Configured manifest endpoint
app.get('/:apiKeys/manifest.json', (req, res) => {
    const { apiKeys } = req.params;
    const debridServices = getDebridServices(apiKeys);
    
    // Check if we have valid API keys
    if (!debridServices.length) {
        return res.json({
            id: 'org.Magnetio',
            version: '1.0.0',
            name: 'Magnetio',
            description: 'Invalid API keys provided - Please check your configuration',
            resources: [],
            types: [],
            catalogs: [],
            behaviorHints: {
                configurable: true,
                configurationRequired: true,
                configurationURL: `${req.protocol}://${req.get('host')}/configure`
            }
        });
    }

    // Return full manifest with streaming capabilities
    const manifest = {
        id: 'org.Magnetio',
        version: '1.0.0',
        name: 'Magnetio',
        description: 'Stream movies via Debrid services',
        resources: ['stream'],
        types: ['movie'],
        catalogs: [],
        behaviorHints: {
            configurable: true
        }
    };
    res.json(manifest);
});

app.get('/:apiKeys/stream/:type/:id.json', async (req, res) => {
    const { apiKeys, type, id } = req.params;
    
    try {
        const debridServices = getDebridServices(apiKeys);
        if (!debridServices.length) {
            throw new Error('No valid debrid service configured');
        }

        const metadata = await getCinemetaMetadata(id);
        if (!metadata?.meta) return res.json({ streams: [] });

        const year = new Date(metadata.meta.released).getFullYear();
        const movieData = await readMovieData(id, year);
        
        const localStreams = movieData?.streams || [];
        let processedStreams = [];
        
        if (localStreams.length > 0) {
            const hashes = localStreams.map(stream => {
                const match = stream.magnetLink.match(/btih:([^&]+)/i);
                return match ? match[1].toLowerCase() : null;
            }).filter(Boolean);

            const cacheResults = {};
            for (const service of debridServices) {
                const results = await checkCacheStatuses(service, hashes);
                Object.entries(results).forEach(([hash, info]) => {
                    if (info.cached) cacheResults[hash] = info;
                });
            }

            processedStreams = localStreams
                .map(stream => {
                    const hash = stream.magnetLink.match(/btih:([^&]+)/i)?.[1]?.toLowerCase();
                    const cacheInfo = cacheResults[hash];
                    if (!cacheInfo?.cached) return null;
                    
                    const quality = stream.quality || stream.websiteTitle.match(/\d{3,4}p|4k|HDTS|CAM/i)?.[0] || '';
                    const size = stream.size || stream.websiteTitle.match(/\d+(\.\d+)?\s*(GB|MB)/i)?.[0] || '';
                    
                    return {
                        name: ['🧲', quality, size, `⚡️ ${cacheInfo.service}`]
                            .filter(Boolean)
                            .join(' | '),
                        title: stream.filename,
                        url: `${req.protocol}://${req.get('host')}/${apiKeys}/${base64Encode(stream.magnetLink)}`,
                        service: cacheInfo.service
                    };
                })
                .filter(Boolean);
        }

        if (processedStreams.length === 0) {
            console.log('\n🔄 No local streams found, fetching from Torrentio...');
            const torrentioStreams = await getTorrentioStreams(id);
            
            if (torrentioStreams.length > 0) {
                await mergeAndSaveStreams(
                    [], 
                    torrentioStreams, 
                    id, 
                    year, 
                    metadata.meta.name
                );

                const hashes = torrentioStreams.map(stream => {
                    const match = stream.magnetLink.match(/btih:([^&]+)/i);
                    return match ? match[1].toLowerCase() : null;
                }).filter(Boolean);

                const cacheResults = {};
                for (const service of debridServices) {
                    const results = await checkCacheStatuses(service, hashes);
                    Object.entries(results).forEach(([hash, info]) => {
                        if (info.cached) cacheResults[hash] = info;
                    });
                }

                processedStreams = torrentioStreams
                    .map(stream => {
                        const hash = stream.magnetLink.match(/btih:([^&]+)/i)?.[1]?.toLowerCase();
                        const cacheInfo = cacheResults[hash];
                        if (!cacheInfo?.cached) return null;
                        
                        return {
                            name: ['🧲', stream.quality, stream.size, `⚡️ ${cacheInfo.service}`]
                                .filter(Boolean)
                                .join(' | '),
                            title: stream.filename,
                            url: `${req.protocol}://${req.get('host')}/${apiKeys}/${base64Encode(stream.magnetLink)}`,
                            service: cacheInfo.service
                        };
                    })
                    .filter(Boolean);
            }
        } else {
            getTorrentioStreams(id).then(async torrentioStreams => {
                if (torrentioStreams.length > 0) {
                    console.log(`Found ${torrentioStreams.length} new streams from Torrentio`);
                    await mergeAndSaveStreams(
                        localStreams, 
                        torrentioStreams, 
                        id, 
                        year, 
                        metadata.meta.name
                    );
                }
            }).catch(error => {
                console.error('Background update error:', error);
            });
        }

        processedStreams.sort((a, b) => {
            const getQuality = name => {
                const quality = name.match(/4k|\d{3,4}/i)?.[0]?.toLowerCase();
                if (quality === '4k') return 2160;
                return parseInt(quality) || 0;
            };
            
            const qualityA = getQuality(a.name);
            const qualityB = getQuality(b.name);
            
            return qualityB - qualityA;
        });

        console.log(`\n✅ Sending ${processedStreams.length} streams`);
        res.json({ streams: processedStreams });

    } catch (error) {
        console.error('❌ Error processing streams:', error);
        res.json({ streams: [] });
    }
});

app.get('/:apiKeys/:magnetLink', async (req, res) => {
    const { apiKeys, magnetLink } = req.params;
    
    try {
        const debridServices = getDebridServices(apiKeys);
        if (!debridServices.length) {
            throw new Error('No valid debrid service configured');
        }

        console.log('\n🧲 Processing magnet request');
        const decodedMagnet = base64Decode(magnetLink);

        for (const service of debridServices) {
            try {
                const streamUrl = await service.getStreamUrl(decodedMagnet);
                return res.redirect(streamUrl);
            } catch (error) {
                console.error('Service failed:', error);
                continue;
            }
        }

        throw new Error('All debrid services failed');

    } catch (error) {
        console.error('❌ Error processing magnet:', error);
        res.status(500).json({ error: 'Failed to process magnet', details: error.message });
    }
});

app.use((err, req, res, next) => {
    console.error('\n❌ Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
});

const port = process.env.PORT || 9516;
app.listen(port, () => console.log(`\n🚀 Addon running at http://localhost:${port}`));
