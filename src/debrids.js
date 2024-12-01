import { ERROR } from './const.js';
import { createHash } from 'crypto';

class BaseDebrid {
    #apiKey;
    
    constructor(apiKey, prefix) {
        this.#apiKey = apiKey.replace(`${prefix}=`, '');
    }

    getKey() {
        return this.#apiKey;
    }
}

class DebridLink extends BaseDebrid {
    constructor(apiKey) {
        super(apiKey, 'dl');
    }

    static canHandle(apiKey) {
        return apiKey.startsWith('dl=');
    }

    async #request(method, path, opts = {}) {
        try {
            const query = opts.query || {};
            const queryString = new URLSearchParams(query).toString();
            const url = `https://debrid-link.com/api/v2${path}${queryString ? '?' + queryString : ''}`;

            opts = {
                method,
                headers: {
                    'User-Agent': 'Stremio',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${this.getKey()}`,
                    ...(method === 'POST' && {
                        'Content-Type': 'application/json'
                    }),
                    ...(opts.headers || {})
                },
                ...opts
            };

            console.log('\n🔷 DebridLink Request:', method, path);
            if (opts.body) console.log('Body:', opts.body);

            const startTime = Date.now();
            const res = await fetch(url, opts);
            console.log(`Response Time: ${Date.now() - startTime}ms`);
            console.log('Status:', res.status);

            const data = await res.json();
            if (!data.success) {
                switch (data.error) {
                    case 'badToken':
                        throw new Error(ERROR.INVALID_API_KEY);
                    case 'maxLink':
                    case 'maxLinkHost':
                    case 'maxData':
                    case 'maxDataHost':
                    case 'maxTorrent':
                    case 'torrentTooBig':
                    case 'freeServerOverload':
                        throw new Error(ERROR.NOT_PREMIUM);
                    default:
                        throw new Error(`API Error: ${JSON.stringify(data)}`);
                }
            }

            return data.value;

        } catch (error) {
            console.error('❌ Request failed:', error);
            throw error;
        }
    }

    async checkCacheStatuses(hashes) {
        try {
            console.log(`\n📡 DebridLink: Batch checking ${hashes.length} hashes`);
            const response = await this.#request('GET', '/seedbox/cached', {
                query: { url: hashes.join(',') }
            });
            
            const results = {};
            for (const hash of hashes) {
                const cacheInfo = response[hash];
                results[hash] = {
                    cached: !!cacheInfo,
                    files: cacheInfo?.files || [],
                    fileCount: cacheInfo?.files?.length || 0,
                    service: 'DebridLink'
                };
            }
            return results;
        } catch (error) {
            if (error.message === ERROR.INVALID_API_KEY) {
                return {};
            }
            console.error('Cache check failed:', error);
            return {};
        }
    }

    async getStreamUrl(magnetLink) {
        try {
            console.log('\n📥 Using DebridLink');
            const data = await this.#request('POST', '/seedbox/add', {
                body: JSON.stringify({
                    url: magnetLink,
                    async: true
                })
            });

            const videoFiles = data.files
                .filter(file => /\.(mp4|mkv|avi|mov|webm)$/i.test(file.name))
                .sort((a, b) => b.size - a.size);

            if (!videoFiles.length) throw new Error('No video files found');
            return videoFiles[0].downloadUrl;
        } catch (error) {
            console.error('❌ Failed to get stream URL:', error);
            throw error;
        }
    }
}

class Premiumize extends BaseDebrid {
    #apiUrl = 'https://www.premiumize.me/api';

    constructor(apiKey) {
        super(apiKey, 'pr');
    }

    static canHandle(apiKey) {
        return apiKey.startsWith('pr=');
    }

    async #request(method, url, opts = {}) {
        const retries = 3;
        let lastError;

        for (let i = 0; i < retries; i++) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 30000);

                const response = await fetch(url, {
                    ...opts,
                    method,
                    signal: controller.signal
                });

                clearTimeout(timeout);
                return await response.json();
            } catch (error) {
                console.log(`Attempt ${i + 1} failed:`, error.message);
                lastError = error;
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        throw lastError;
    }

    async checkCacheStatuses(hashes) {
        try {
            console.log(`\n📡 Premiumize: Batch checking ${hashes.length} hashes`);
            const params = new URLSearchParams({ apikey: this.getKey() });
            hashes.forEach(hash => params.append('items[]', hash));

            const data = await this.#request('GET', `${this.#apiUrl}/cache/check?${params}`);
            
            if (data.status !== 'success') {
                if (data.message === 'Invalid API key.') return {};
                throw new Error('API Error');
            }

            const results = {};
            hashes.forEach((hash, index) => {
                results[hash] = {
                    cached: data.response[index],
                    files: [],
                    fileCount: 0,
                    service: 'Premiumize'
                };
            });
            return results;
        } catch (error) {
            console.error('Cache check failed:', error);
            return {};
        }
    }

    async getStreamUrl(magnetLink) {
        try {
            console.log('\n📥 Using Premiumize');
            
            const body = new FormData();
            body.append('apikey', this.getKey());
            body.append('src', magnetLink);  // Using full magnet link instead of just hash

            const data = await this.#request('POST', `${this.#apiUrl}/transfer/directdl`, {
                body
            });

            if (data.status !== 'success') {
                console.error('API Error:', data);  // Added full error logging
                throw new Error('Failed to add magnet');
            }

            const videoFiles = data.content
                .filter(file => /\.(mp4|mkv|avi|mov|webm)$/i.test(file.path))
                .sort((a, b) => b.size - a.size);
                
            if (!videoFiles.length) throw new Error('No video files found');
            return videoFiles[0].link;
        } catch (error) {
            console.error('❌ Failed to get stream URL:', error);
            throw error;
        }
    }
}

export function getDebridServices(apiKeys) {
    const services = [];
    
    for (const key of apiKeys.split(',')) {
        if (DebridLink.canHandle(key)) {
            services.push(new DebridLink(key));
        } else if (Premiumize.canHandle(key)) {
            services.push(new Premiumize(key));
        }
    }
    
    return services;
}

export { DebridLink, Premiumize };
