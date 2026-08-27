# DeskDrop

A browser-based local-network clipboard sync and file transfer tool. Open it on any two devices on the same network — they find each other automatically, no accounts, no pairing codes, no configuration.

**[Live Demo →](https://deskdrop-production.up.railway.app/)**

---

## What It Does

- **Clipboard sync** — type or paste on one device, it appears instantly on all others
- **File transfer** — drag a file onto the browser window and it downloads on the other device
- **Zero friction** — no login, no install, no QR code. Open the URL on two devices and start sharing
- **Targeted send** — click a device card to send only to that device; click again to deselect

---

## How Devices Find Each Other

When a device connects, the server extracts its public IP from the `x-forwarded-for` header and uses it as a room key. Devices behind the same router share one public IP via NAT — they automatically land in the same room.

```
Your laptop:  110.172.55.177  →  room: "subnet:110.172.55.177"
Your phone:   110.172.55.177  →  room: "subnet:110.172.55.177"  ← same room ✓
```

This works for home WiFi, office networks, and mobile hotspots. No signup required.

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Server runtime | Node.js | Event loop suits long-lived WebSocket connections |
| WebSocket library | `ws` (raw) | Not Socket.IO — see design decisions |
| HTTP server | Express + `express-ws` | Serves static files and mounts WS endpoint on same port |
| Frontend | Vanilla JS | Keeps protocol logic visible and unabstracted |
| Chunk storage | IndexedDB | Off-heap storage — prevents OOM on large file receives |
| Deployment | Railway | Persistent WebSocket connections, no idle spin-down |

---

## Architecture

```
Browser (public/app.js)          Node.js (server/index.js)
─────────────────────            ──────────────────────────
connect()                   →    app.ws('/ws', handler)
                            ←    room-snapshot (JSON)
renderPresencePanel()
                                 heartbeat every 15s
                                 ws.ping() → browser auto-pongs
                                 zombie detection → ws.terminate()

User types in textarea      →    handleClipBoard()
                                 broadCastToRoom() or sendToDevices()
                            ←    clipboard (JSON)
textarea.value = msg.data

User drops a file
sendFile():
  sendJSON(file-meta)       →    handleFileMeta()
                                 ws.meta.streamState = { ... }
                                 forward file-meta to targets
  ws.send(chunk 0..N)       →    handleBinaryChunk()
                                 forward raw buffer to targets
  sendJSON(file-eof)        →    handleFileEof()
                                 forward file-eof, clear streamState
                            ←    file-meta + binary chunks + file-eof
                                 writeChunk() → IndexedDB
                                 readAllChunks() → Blob → a.click()
```

### Room State

```
Map<roomKey, Map<deviceId, WebSocket>>

roomKey examples:
  "subnet:110.172.55.177"   ←  auto-discovery (same public gateway)
  "subnet:192.168.0"        ←  local dev (private /24 subnet)
  "subnet:v6:2409:40e0:102b:2ac8"  ←  native IPv6 (Jio/Airtel mobile)
```

### File Transfer Protocol

Pure binary frames carry file data. JSON frames carry coordination. No custom binary headers.

```
Sender                    Server                    Receiver
──────                    ──────                    ────────
file-meta (JSON) ──────────────────────────────→  handleFileMeta()
                          streamState = active       open IndexedDB
                          forward meta ────────────→

chunk 0 (binary) ──────────────────────────────→
                          forward buffer ──────────→  writeChunk(0)
chunk 1 (binary) ──────────────────────────────→
                          forward buffer ──────────→  writeChunk(1)
...
file-eof (JSON)  ──────────────────────────────→
                          clear streamState
                          forward eof ─────────────→  readAllChunks()
                                                       new Blob(chunks)
                                                       a.click() → download
                                                       deleteChunks()
```

WebSocket guarantees FIFO ordering within a single connection. Chunk sequence numbers are therefore redundant — the receiver's counter is its own implicit index.

---

## Running Locally

```bash
git clone https://github.com/Koulik001/deskdrop.git
cd deskdrop
npm install
npm run dev        # starts server on http://localhost:3000
```

Open `http://localhost:3000` in two browser tabs. Both land in `subnet:local` and see each other immediately.

To test across real devices on the same WiFi, use [ngrok](https://ngrok.com):

```bash
ngrok http 3000
# opens a public tunnel — open the ngrok URL on your phone
```

**Node.js 18+ required.**

---

## Deployment (Railway)

1. Push the repo to GitHub
2. Create a [Railway](https://railway.app) account → New Project → Deploy from GitHub
3. Railway auto-detects Node.js and reads the `start` script
4. Go to Settings → Networking → Generate Domain
5. Open the live URL on two devices — done

No environment variables required. `PORT` is injected by Railway automatically.

---

## Design Decisions and Alternatives Considered

This section documents the non-obvious choices made during development and the alternatives that were evaluated and rejected.

---

### Why `ws` (raw WebSocket) instead of Socket.IO

Socket.IO is the most common WebSocket abstraction for Node.js. It was rejected deliberately.

Socket.IO hides the underlying protocol behind a custom framing layer, automatic reconnection logic, and an event system that works differently from native WebSocket. In an interview, "I used Socket.IO" is hard to probe beyond the surface. "I used raw `ws`" opens protocol-level questions about ping/pong, binary vs text frames, FIFO ordering, and backpressure — all of which have real answers.

The tradeoff is that features Socket.IO provides for free (reconnect, room abstraction, event routing) had to be built manually. Every one of those manual implementations is a talking point.

---

### Why pure binary frames with JSON control packets

The first design used custom binary headers — embedding a `transferId` and chunk index as raw bytes prepended to each frame:

```
[4 bytes: chunkIndex][16 bytes: transferId][...file data]
```

This was rejected for two reasons. First, manually packing bytes with `DataView` and reconstructing them at the receiver with byte-offset arithmetic is error-prone — one wrong offset silently corrupts the entire file. Second, it adds two memory copies per chunk on the sender side.

The final design uses WebSocket's FIFO guarantee as the sequencing mechanism. Since messages within a single connection are delivered in order, chunk sequence is implicit. No headers needed. Binary frames are 100% file data.

JSON frames carry all coordination (`file-meta`, `file-eof`). Clean separation between data and control.

---

### Room grouping — the CGNAT problem

The initial approach took the first three octets of the client's IP as the room key (`192.168.1`). After testing with ngrok, two issues appeared:

**Problem 1 — Indian mobile carriers assign native IPv6.** When connecting from a Jio or Airtel mobile data connection, the raw address from `x-forwarded-for` was `2409:40e0:102b:2ac8:8000::` — not the IPv4-mapped `::ffff:` format that Node produces for IPv4 clients on IPv6 sockets. The original code used `raw.replace('::ffff:', '')` and then checked `parts.length === 4` — which silently bucketed all native IPv6 clients into `subnet:local`. Discovered via `traceroute` — hop 11 showed the first public IPv6 address in the path. Fixed with a separate `classifyIPv6()` path using the /64 prefix (first four groups).

**Problem 2 — CGNAT means subnet slicing is wrong in production.** All devices behind the same ISP CGNAT block share one public IP gateway (verified by traceroute). `/24` subnet slicing would group devices on different home routers into the same room if they share a CGNAT block. The correct primitive is the exact public IP — devices behind the same NAT router share one public IP, so exact match already guarantees "same router = same room."

The final `extractRoomKey` function handles four cases:
- `::ffff:` IPv4-mapped → strip prefix → `classifyIPv4()`
- Contains `:` without `::ffff:` → native IPv6 → `classifyIPv6()` with /64 prefix
- Private IPv4 (RFC 1918) → `/24` subnet (local dev)
- Public IPv4 → exact IP (production)

---

### Why not WebRTC for local IP discovery

WebRTC's ICE candidate gathering exposes the device's local LAN IP (`192.168.0.x`) without a permission prompt. This would allow grouping by local subnet — more precise than public IP and immune to CGNAT collisions.

It was evaluated and rejected for two reasons. Residual private IP collision still exists (two neighbours could both have `192.168.0.x` if their routers use the same default subnet). And WebRTC adds significant stack complexity for a capability that is already handled adequately by the public IP approach for the target use case (same home/office network).

---

### Why not geo-hashing (HTML5 Geolocation API)

A proposed alternative used `navigator.geolocation.getCurrentPosition()` to get GPS coordinates, rounded to two decimal places (~1.1km box), combined with public IP as a composite room key. Rejected for three concrete reasons:

1. **Browser permission prompt** — the Geolocation API requires explicit user consent. A modal on first load directly contradicts the "zero friction" design goal.
2. **HTTPS-only** — the API is blocked on `http://`. Local development would be impossible without deployment.
3. **GPS drift indoors** — coordinate rounding to two decimal places sounds precise but indoor GPS on phones and laptops drifts 50–200 metres. In dense urban areas, your own laptop and phone could land in different grid boxes.

---

### Trust model

In a CGNAT scenario, two devices on different home routers but the same ISP block could theoretically land in the same room. This is acknowledged and handled at the UX layer rather than the protocol layer:

- The presence panel shows who is in the room. A user can see unfamiliar devices.
- Targeted send (clicking a specific device card) means data is only sent to consciously chosen targets.
- A manual room code (future feature) provides guaranteed isolation.

The system's job is best-effort grouping. The user makes the final trust decision. This is the correct division of responsibility for a zero-auth tool.

---

### Device disambiguation — deterministic pet names

Early designs labelled devices as "Mobile" or "Desktop" by `navigator.userAgent`. With three phones in a room, three identical "📱 Mobile" labels are indistinguishable.

The solution is deterministic names derived from the device's UUID:

```js
const adj   = parseInt(deviceId[0], 16) % ADJECTIVES.length  // 0–14
const animal = parseInt(deviceId[2], 16) % ANIMALS.length     // 0–14
return `${ADJECTIVES[adj]} ${ANIMALS[animal]}`                 // "swift panda"
```

Same UUID always produces the same name. 15 × 15 = 225 unique combinations. The name is visible on both devices, so a user can identify their own device ("I'm swift panda") and find it in the other device's presence panel.

---

### Zombie connection detection

Mobile operating systems aggressively pause browser tabs when the screen locks. The underlying TCP connection stays open but the app layer is frozen. The server cannot distinguish a sleeping phone from an active one — the TCP socket looks healthy.

Detection uses RFC 6455 native ping/pong frames (opcode `0x9` and `0xA`) rather than a JSON-layer heartbeat. Every 15 seconds the server iterates all connected sockets, sets `ws.meta.isAlive = false`, and calls `ws.ping()`. The browser's WebSocket implementation automatically responds with a pong — no frontend code needed. If `isAlive` is still false on the next cycle, the socket is terminated with `ws.terminate()` (hard kill, no handshake) and a `presence:leave` is broadcast to the room.

---

## Known Limitations

**Head-of-line blocking.** WebSocket runs on one TCP connection — a single ordered byte stream. A large file transfer queues binary chunks into the TCP send buffer. Text messages (clipboard) sent during the transfer wait behind all queued chunks. At 20Mbps WiFi, a 260MB file occupies the pipe for ~100 seconds. Fix: a second WebSocket connection, one for control traffic and one for binary, giving them independent TCP streams.

**Single active receive.** Binary frames carry no transferId header — the receiver's sequential counter is the implicit chunk index. This means two simultaneous incoming transfers are indistinguishable at the binary layer. If two devices send to the same receiver simultaneously, chunks intermix and both files corrupt. Fix requires either a second WebSocket connection per transfer or embedded transferId in binary frames.

**No integrity verification.** There is no checksum on the transferred file. Transport-layer integrity is provided by TLS (HMAC on every TLS record). Application-layer checksum (MD5 or SHA-256 included in `file-meta`, recomputed after Blob assembly) would provide an additional layer.

**No end-to-end encryption.** Data travels encrypted in transit (TLS between browser and server) but the server sees plaintext. A production implementation would use the WebCrypto API — ECDH key exchange on room join, AES-GCM for symmetric encryption of clipboard content and file chunks.

**500MB soft limit.** The `new Blob(chunks)` assembly step briefly allocates the full file in the V8 heap. Above ~500MB this risks crashing the browser tab on memory-constrained devices. Fix: StreamSaver.js or the File System Access API to pipe chunks directly to a writable file stream without ever holding the full file in memory.

---

## File Structure

```
deskdrop/
├── server/
│   ├── index.js           # Express server, WebSocket endpoint, heartbeat
│   ├── roomManager.js     # Map<roomKey, Map<deviceId, ws>> + broadcast helpers
│   └── messageHandler.js  # JSON message routing, file transfer state machine
├── public/
│   ├── index.html         # Shell — presence panel, clipboard section, file section
│   ├── style.css          # Dark theme, device cards, progress bars
│   └── app.js             # WebSocket client, IndexedDB, all UI logic
└── package.json
```

---

## License

MIT
