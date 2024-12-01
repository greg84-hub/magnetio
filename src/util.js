import { VIDEO_EXTENSIONS } from './const.js';

export function isVideo(filename) {
    return VIDEO_EXTENSIONS.some(ext => 
        filename.toLowerCase().endsWith(ext)
    );
}

export function extractInfoHash(magnetLink) {
    const match = magnetLink.match(/xt=urn:btih:([^&]+)/i);
    return match ? match[1].toLowerCase() : null;
}

export async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function base64Encode(str) {
    return Buffer.from(str).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

export function base64Decode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64').toString('ascii');
}
