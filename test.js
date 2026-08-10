const http = require('http');

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const html = `
    <html>
    <head><title>Test Page</title></head>
    <body><h1>Hello from Node.js HTTP Server!</h1></body>
    </html>
    `;
    res.end(html);
});

const port = 8080;
server.listen(port, () => {
    console.log(`Serving custom HTML at http://localhost:${port}`);
});