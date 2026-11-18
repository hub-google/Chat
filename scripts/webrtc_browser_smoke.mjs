// Real Chromium/Chrome WebRTC smoke test using the built-in CDP WebSocket.
// This does not require Puppeteer, Supabase credentials, TURN, or remote services.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = (ms, label) => new Promise((_, reject) =>
  setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms));

const browserPath = [process.env.CHROME_BIN, 'google-chrome', 'chromium', 'chromium-browser']
  .filter(Boolean)
  .find((candidate) => spawnSync('which', [candidate], { encoding: 'utf8' }).status === 0);
if (!browserPath) {
  console.error('Chrome or Chromium is not installed on this runner.');
  process.exit(1);
}

const script = String.raw`(async () => {
  const deadline = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' exceeded ' + ms + 'ms')), ms)),
  ]);
  if (!window.isSecureContext || typeof RTCPeerConnection !== 'function') {
    throw new Error('WebRTC not exposed in secure localhost Chromium context');
  }

  const a = new RTCPeerConnection({ iceServers: [] });
  const b = new RTCPeerConnection({ iceServers: [] });
  try {
    const received = new Promise((resolve) => {
      b.ondatachannel = (event) => {
        event.channel.onmessage = (message) => resolve(message.data);
      };
    });
    const dataChannel = a.createDataChannel('tunnel-local-browser-smoke');
    const opened = new Promise((resolve) => {
      if (dataChannel.readyState === 'open') resolve();
      else dataChannel.onopen = resolve;
    });

    const gatheringComplete = (pc) => {
      if (pc.iceGatheringState === 'complete') return Promise.resolve();
      return deadline(new Promise(resolve => {
        const check = () => {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener('icegatheringstatechange', check);
            resolve();
          }
        };
        pc.addEventListener('icegatheringstatechange', check);
        check();
      }), 8000, 'ICE gathering');
    };

    await a.setLocalDescription(await a.createOffer());
    await gatheringComplete(a);
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await gatheringComplete(b);
    await a.setRemoteDescription(b.localDescription);

    await deadline(opened, 12000, 'datachannel open');
    const start = performance.now();
    dataChannel.send('TUNNEL-P2P-BROWSER-OK');
    const delivered = await deadline(received, 3000, 'datachannel delivery');
    const latencyMs = Math.round(performance.now() - start);
    if (delivered !== 'TUNNEL-P2P-BROWSER-OK') throw new Error('Message corrupted in P2P channel');
    if (latencyMs > 1000) throw new Error('Local P2P delivery exceeded one second');
    return { passed: true, latencyMs, stateA: a.connectionState, stateB: b.connectionState };
  } finally {
    a.close();
    b.close();
  }
})()`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-chrome-'));
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html lang="en"><title>Tunnel P2P Browser Smoke</title></html>');
});
let chrome;
let socket;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const localPort = server.address().port;
  chrome = spawn(browserPath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    '--user-data-dir=' + dir, 'http://127.0.0.1:' + localPort,
  ], { stdio: 'ignore' });

  const portFile = path.join(dir, 'DevToolsActivePort');
  const started = Date.now();
  while (!fs.existsSync(portFile)) {
    if (chrome.exitCode !== null) throw new Error('Chrome exited before DevTools was ready');
    if (Date.now() - started > 12000) throw new Error('Chrome DevTools startup timeout');
    await sleep(100);
  }

  const chromePort = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  const pages = await Promise.race([
    fetch('http://127.0.0.1:' + chromePort + '/json').then((res) => res.json()),
    timeout(6000, 'DevTools page enumeration'),
  ]);
  const tab = pages.find((page) => page.type === 'page');
  if (!tab?.webSocketDebuggerUrl) throw new Error('No Chrome page target available');

  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }),
    timeout(6000, 'DevTools websocket connection'),
  ]);

  let id = 0;
  const callbacks = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const callback = callbacks.get(message.id);
    if (callback) {
      callbacks.delete(message.id);
      if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
      else callback.resolve(message.result);
    }
  });
  const command = (method, params) => new Promise((resolve, reject) => {
    const next = ++id;
    callbacks.set(next, { resolve, reject });
    socket.send(JSON.stringify({ id: next, method, params }));
  });

  const report = await Promise.race([
    command('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true }),
    timeout(22000, 'WebRTC browser test'),
  ]);
  if (report.exceptionDetails) throw new Error(report.exceptionDetails.text +
    ': ' + (report.exceptionDetails.exception?.description || 'unknown browser error'));
  if (report.result?.value?.passed !== true) throw new Error('Browser test returned no successful result');
  console.log('PASS: real Chromium peer-to-peer DataChannel message, ' +
    JSON.stringify(report.result.value));
} catch (error) {
  console.error('FAIL: Chrome/WebRTC browser smoke:', error);
  process.exitCode = 1;
} finally {
  socket?.close();
  chrome?.kill('SIGTERM');
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
