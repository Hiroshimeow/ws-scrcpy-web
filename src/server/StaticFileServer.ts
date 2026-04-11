import * as fs from 'fs';
import * as path from 'path';
import { IncomingMessage, ServerResponse } from 'http';

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.jar': 'application/java-archive',
    '.map': 'application/json',
};

export function createStaticHandler(publicDir: string): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
        const urlPath = new URL(req.url || '/', `http://${req.headers.host}`).pathname;
        let filePath = path.join(publicDir, urlPath === '/' ? 'index.html' : urlPath);

        // Normalize and prevent directory traversal
        filePath = path.resolve(filePath);
        if (!filePath.startsWith(path.resolve(publicDir))) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        fs.stat(filePath, (err, stats) => {
            if (err || !stats.isFile()) {
                // Serve index.html as fallback for SPA routing
                const indexPath = path.join(publicDir, 'index.html');
                res.writeHead(200, { 'Content-Type': 'text/html' });
                fs.createReadStream(indexPath).pipe(res);
                return;
            }
            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': contentType });
            fs.createReadStream(filePath).pipe(res);
        });
    };
}
